// Brainshark playback and read-only completion observations. Never writes SCORM
// results or the player's progress store. Requirements come from the live
// player store, with visible playback and completion controls as evidence.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataPath } = require('./paths');

const adapters = new WeakMap();
const CONTINUE_PLAYBACK = 'Continue with playback';
const STOP_PLAYBACK = 'Stop for now';
const CONTINUE_LISTENING_QUESTION = 'The course is still playing. Would you like Vitriol to continue with the listening requirement?';

async function completionReader(frame) {
  const cdp = await frame.page().context().newCDPSession(frame);
  const group = `vitriol-completion-${Date.now()}`;
  const properties = async objectId => (await cdp.send('Runtime.getProperties', { objectId, ownProperties: true })).result;
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'window.ngCheetah?.getPresentationWithSlideById', objectGroup: group,
    });
    if (!result.objectId) throw Error('Player completion data is unavailable');
    const fn = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    const scopes = fn.internalProperties?.find(item => item.name === '[[Scopes]]')?.value?.objectId;
    if (!scopes) throw Error('Player completion data is unavailable');
    let instances;
    for (const scope of (await properties(scopes)).slice(0, 3)) {
      if (!scope.value?.objectId || !scope.value.description?.startsWith('Block')) continue;
      for (const item of await properties(scope.value.objectId)) {
        if (item.value?.type !== 'function' || !item.value.description?.startsWith('class ')) continue;
        const prototype = (await properties(item.value.objectId)).find(entry => entry.name === 'prototype')?.value?.objectId;
        if (!prototype) continue;
        const queried = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype, objectGroup: group });
        instances = queried.objects.objectId;
        break;
      }
      if (instances) break;
    }
    if (!instances) throw Error('Player completion data is unavailable');
    return {
      async read() {
        const response = await cdp.send('Runtime.callFunctionOn', {
          objectId: instances, returnByValue: true,
          functionDeclaration: `function() {
            const instance = Array.from(this).slice(0, 8).find(item => typeof item.store?.state === 'function');
            const state = instance?.store.state()?.ngPanther;
            const presentation = state?.presentation;
            const completion = state?.completionCriteria;
            if (!presentation?.settings || !completion) return null;
            const settings = presentation.settings;
            const bounded = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
            return {
              requiredSlides: bounded(settings.slidescriteria), requiredAudio: bounded(settings.audiocriteria),
              requiredScore: bounded(settings.scorecriteria), slidesPercent: bounded(completion.slideProgress),
              audioPercent: bounded(completion.audioProgressPct), scorePercent: bounded(completion.questionProgress),
              durationSeconds: typeof presentation.seconds === 'number' && presentation.seconds > 0 && presentation.seconds <= 86400 ? presentation.seconds : null,
              presentationId: String(presentation.id || presentation.pi || '').slice(0, 80),
            };
          }`,
        });
        return response.result.value ?? null;
      },
      async close() {
        await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
        await cdp.detach().catch(() => {});
      },
    };
  } catch (error) {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    await cdp.detach().catch(() => {});
    throw error;
  }
}

async function readBrainshark(page) {
  let adapter = adapters.get(page);
  if (!adapter || adapter.frame.isDetached()) {
    if (adapter) await adapter.reader?.close();
    for (const frame of page.frames().slice(0, 16)) {
      const matches = await frame.evaluate(() => location.hostname === 'www.brainshark.com'
        && Boolean(document.querySelector('[aria-label="scrub-bar"],.completion-message'))).catch(() => false);
      if (!matches) continue;
      adapter = { frame, reader: await completionReader(frame).catch(() => null) };
      adapters.set(page, adapter);
      break;
    }
  }
  if (!adapter || adapter.frame.isDetached()) return null;
  const visible = await adapter.frame.evaluate(() => {
    const slide = document.querySelector('[id^="slide-list-slide-"].active');
    const scrub = document.querySelector('[aria-label="scrub-bar"]');
    const label = document.querySelector('.completion-message')?.textContent?.replace(/\s+/g, ' ').trim();
    const fields = [...document.querySelectorAll('input,textarea')].filter(el => el.checkVisibility()
      && (['radio','checkbox','text'].includes(el.type) || el.tagName === 'TEXTAREA'));
    const submit = [...document.querySelectorAll('button,[role=button]')].find(el => el.checkVisibility() && /^submit$/i.test(el.textContent.trim()));
    const answered = fields.some(el => (el.disabled || el.readOnly) && (el.checked || (typeof el.value === 'string' && !['radio','checkbox'].includes(el.type) && el.value.trim())));
    return {
      title: document.title.slice(0, 200),
      slide: slide ? Number(slide.id.split('-').at(-1)) + 1 : null,
      totalSlides: document.querySelectorAll('[id^="slide-list-slide-"]').length,
      slideTitle: slide?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160),
      elapsedMs: Number(scrub?.getAttribute('aria-valuenow')),
      durationMs: Number(scrub?.getAttribute('aria-valuemax')),
      playing: document.getElementById('play-pause-button')?.getAttribute('aria-label') === 'pause',
      completed: /COMPLETION CRITERIA:\s*(?:COMPLETED|MET)$/i.test(label || ''),
      question: Boolean(fields.length || submit), answered, submitVisible: Boolean(submit),
    };
  }).catch(() => null);
  if (!visible) return null;
  const requirements = await adapter.reader?.read().catch(() => null);
  const identity = createHash('sha256').update(JSON.stringify([visible.title, requirements?.presentationId,
    visible.totalSlides, requirements?.durationSeconds, requirements?.requiredAudio, requirements?.requiredSlides, requirements?.requiredScore])).digest('hex');
  return { ...visible, requirements: requirements ?? null, identity, provider: 'brainshark' };
}

function listeningQuestion(playback) {
  const requirements = playback.requirements;
  if (requirements?.requiredAudio === 0) return null;
  const minutes = requirements?.durationSeconds && requirements?.requiredAudio
    ? Math.ceil(requirements.durationSeconds * requirements.requiredAudio / 6000) : null;
  const detail = requirements?.requiredAudio != null
    ? `This course requires ${requirements.requiredAudio}% of its audio to be played${minutes ? `, about ${minutes} minutes of credited audio` : ''}.`
    : 'This course may require audio playback. Its exact listening requirement could not be read.';
  return { question: `${detail} Vitriol can play at 2x speed, check the credit earned, and handle questions. Would you like to continue?`, options: [CONTINUE_PLAYBACK, STOP_PLAYBACK] };
}

function consentKey(conversationId, playback) {
  return createHash('sha256').update(`${conversationId}\n${playback.identity}`).digest('hex');
}

function playbackApproved(conversationId, playback, guidance = '') {
  const question = listeningQuestion(playback);
  if (!question) return true;
  const exactReply = `Previous question: ${question.question}\nUser answer: ${CONTINUE_PLAYBACK}`;
  // This comes only from the signed job input, never a page or model action.
  const replied = guidance === exactReply;
  const declined = [question.question, CONTINUE_LISTENING_QUESTION].some(prompt => guidance === `Previous question: ${prompt}\nUser answer: ${STOP_PLAYBACK}`);
  if (!/^[a-f0-9-]{36}$/i.test(conversationId || '')) return replied && !declined;
  const file = dataPath('playback-approvals', `${consentKey(conversationId, playback)}.json`);
  if (declined) {
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, JSON.stringify({approvedAt:0}));
    return false;
  }
  if (replied) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ approvedAt: Date.now() }));
    return true;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(saved.approvedAt) && Date.now() - saved.approvedAt >= 0 && Date.now() - saved.approvedAt < 12 * 60 * 60 * 1000;
  } catch { return false; }
}

async function playbackControl(page, action) {
  const adapter = adapters.get(page);
  if (!adapter) throw Error('The course player changed');
  if (action === 'next') return adapter.frame.locator('#next-button').click({ timeout: 5000 });
  if (action === 'restart') return adapter.frame.locator('#slide-list-slide-0').click({timeout:5000});
  const button = adapter.frame.locator('#play-pause-button');
  const label = await button.getAttribute('aria-label');
  if ((action === 'play' && label === 'play') || (action === 'pause' && label === 'pause')) await button.click({ timeout: 5000 });
}

async function setPlaybackSpeed(page, speed) {
  const adapter = adapters.get(page);
  if (!adapter || ![1,2].includes(speed)) return;
  await adapter.frame.evaluate(rate => {
    for (const media of document.querySelectorAll('audio,video')) {
      if (media.playbackRate !== rate) media.playbackRate = rate;
    }
  },speed);
}

async function closeBrainsharkReaders(pages) {
  for (const page of pages) {
    await adapters.get(page)?.reader?.close();
    adapters.delete(page);
  }
}

module.exports = { readBrainshark, listeningQuestion, playbackApproved, playbackControl, setPlaybackSpeed, closeBrainsharkReaders, CONTINUE_LISTENING_QUESTION };
