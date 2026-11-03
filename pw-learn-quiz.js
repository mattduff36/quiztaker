#!/usr/bin/env node
// pw-learn-quiz.js
//
// Confirmed quiz learner for a tab the hosted detector does not already solve.
// The script only reads the page and applies actions the control plane has
// already allowlisted. It has no API key and does not call the control plane.
// Default read mode collects course material without submitting assessments.
// Signed helper job input supplies quiz mode to allow observed quiz submission.
// Every observed viewport is sent to the provider with saved course context;
// an ask-user action
// prints LEARNER_QUESTION and stops with needs-user-input. That is incomplete
// and never a successful completion. The same action and target on an unchanged
// view stops after three attempts and asks the operator to resume. Guidance is
// not a shell argument.
// Quiz jobs allow at most two observed Retake/Retry actions; failed-result
// snapshots are retained before those actions, and only visible passes finish.
// Hidden persistent slides never consume the visible-control scan budget;
// transformed-away flipcard faces and hidden headings are not observations.
// Read-only DOM family markers support source-linked player knowledge; they
// never authorize actions, identify an exact version or provide quiz answers.
//
// Usage:
//   node pw-learn-quiz.js <tabIdx> [--dry]

const readline = require('node:readline');
const { chromium } = require('playwright');
const { observePlayerEvidence } = require('./lib/player-evidence');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const MAX_STEPS = 80;
const MAX_QUIZ_RETRIES = 2;
const RETRY_LABEL = /\b(retake|retry)\b/i;
const SUBMIT_LABEL = /\b(submit|finish|end test|end quiz|grade)\b/i;
const UNSAFE_LABEL = /\b(log\s*out|sign\s*out|sign\s*in|log\s*in|password|account|payment|purchase|buy|delete|remove|unsubscribe|exit|close browser)\b/i;
const ASSESSMENT_START_LABEL = /\b(?:(?:start|begin|launch|take)(?:\s+the)?\s+(?:test|quiz|assessment)|retake|retry)\b/i;
const NAVIGATION_LABEL = /^(next(?: page| slide)?|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch|resume|menu|home|contents)$/i;
const OPEN_TOPIC_LABEL = /^Open topic: .{1,140}$/;
const COURSE_INTERACTION_LABEL = /^Course interaction: \d+_\d+_click_?\d+$/;
const REPEATED_VIEW_LIMIT = 3;
const REPEATED_VIEW_OPTION = 'Done, resume now';
const PASS_EVIDENCE = /\byou (?:have )?passed\b|\b(?:result|status):\s*passed\b|\byour score:\s*100\s*%/i;
const FAIL_EVIDENCE = /\bnot (?:\w+\s+){0,3}pass(?:ed)?\b|\b(did not pass|haven't passed|failed|unsuccessful|not successful)\b/i;
const ALLOWED = new Set(['click', 'answer-select', 'select-tab', 'scroll', 'wait', 'capture', 'verify', 'ask-user']);
const LEARNER_NEEDS_INPUT = 'needs-user-input';
const NO_CONTROLS_QUESTION = 'Open the intended question or module, then resume.';

function parseLearnQuizArgs(argv) {
  const tokens = argv.slice(2);
  if (tokens.length < 1) throw new Error('Usage: pw-learn-quiz.js <tabIdx> [--dry]');
  if (!/^\d+$/.test(tokens[0])) throw new Error('Tab index must be a number');
  if (tokens.length > 2 || (tokens[1] && tokens[1] !== '--dry')) {
    throw new Error('Only --dry is allowed');
  }
  return { tabIdx: Number(tokens[0]), dryRun: tokens[1] === '--dry' };
}

function pageShowsPass(snapshot) {
  const text = `${snapshot?.title || ''}\n${snapshot?.text || ''}`;
  if (snapshot?.choices?.length) return false;
  if (FAIL_EVIDENCE.test(text)) return false;
  return PASS_EVIDENCE.test(text);
}

function parseAskUser(action) {
  if (!action || action.action !== 'ask-user') return { error: 'Learner question is invalid' };
  if (typeof action.question !== 'string') return { error: 'Learner question is invalid' };
  const question = action.question.trim();
  if (!question || question.length > 500) return { error: 'Learner question is invalid' };
  if (action.options == null) return { question };
  if (!Array.isArray(action.options) || action.options.length > 3) {
    return { error: 'Learner question options are invalid' };
  }
  const options = [];
  for (const option of action.options) {
    if (typeof option !== 'string') return { error: 'Learner question options are invalid' };
    const text = option.trim();
    if (!text || text.length > 120) return { error: 'Learner question options are invalid' };
    options.push(text);
  }
  return options.length ? { question, options } : { question };
}

function learnerQuestionPayload(snapshot, action) {
  const buttons = Array.isArray(snapshot?.buttons) ? snapshot.buttons.length : 0;
  const choices = Array.isArray(snapshot?.choices) ? snapshot.choices.length : 0;
  if (!action && buttons + choices === 0) return { question: NO_CONTROLS_QUESTION };
  const parsed = parseAskUser(action);
  if (parsed.error) return null;
  return parsed.options ? { question: parsed.question, options: parsed.options } : { question: parsed.question };
}

function learnerQuestionLine(payload) {
  return `LEARNER_QUESTION ${JSON.stringify(payload)}`;
}

function clickLabelAllowed(name) {
  const trimmed = String(name || '').trim();
  return NAVIGATION_LABEL.test(trimmed) || OPEN_TOPIC_LABEL.test(trimmed) || COURSE_INTERACTION_LABEL.test(trimmed);
}

function screenElementControlName(id, className) {
  const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
  if (!classes.has('screenElement')) return '';
  if (classes.has('backbtn')) return 'Previous';
  if (classes.has('nextbtn')) return 'Next';
  if (classes.has('box') && /^\d+_\d+_click_?\d+$/.test(String(id || ''))) {
    return `Course interaction: ${id}`;
  }
  return '';
}

function learnerActionSignature(action) {
  const name = typeof action?.action === 'string' ? action.action : '';
  const targetId = typeof action?.targetId === 'string' ? action.targetId : '';
  return `${name}\u0000${targetId}`;
}

function noteRepeatedLearnerAction(state, action, snapshot) {
  const signature = learnerActionSignature(action);
  const same = Boolean(state)
    && state.signature === signature
    && sameLearnerView(state.snapshot, snapshot);
  const count = same ? state.count + 1 : 1;
  if (count >= REPEATED_VIEW_LIMIT) {
    return {
      state: { signature: '', snapshot: null, count: 0 },
      question: {
        question: 'This action has not changed the page. Choose Done, resume now when you want another look.',
        options: [REPEATED_VIEW_OPTION],
      },
    };
  }
  return { state: { signature, snapshot, count }, question: null };
}

function localActionAllowed(action, snapshot, mode = 'read') {
  if (!action || typeof action !== 'object') return false;
  if (!ALLOWED.has(action.action)) return false;
  if (action.action === 'ask-user') return learnerQuestionPayload(snapshot, action) != null;
  if (action.action === 'select-tab') {
    const target = snapshot.tabs?.find(tab => tab.id === action.targetId);
    if (!target || !/^t\d{1,3}$/.test(action.targetId) || UNSAFE_LABEL.test(target.name)) return false;
    try { const current = new URL(snapshot.url); return /^https?:$/.test(current.protocol) && new URL(target.url).origin === current.origin; } catch { return false; }
  }
  if (action.action === 'click' || action.action === 'answer-select') {
    const pool = action.action === 'click' ? snapshot.buttons : snapshot.choices;
    const target = (pool || []).find((item) => item.id === action.targetId);
    if (!target) return false;
    if (action.action === 'click') {
      if (UNSAFE_LABEL.test(target.name)) return false;
      if (ASSESSMENT_START_LABEL.test(target.name)) return mode === 'quiz';
      if (SUBMIT_LABEL.test(target.name) || target.kind === 'submission' || target.kind === 'quiz-navigation') return mode === 'quiz';
      if (!['content', 'navigation'].includes(target.kind) && !clickLabelAllowed(target.name)) return false;
    }
  }
  return true;
}

async function accessibleName(locator) {
  const aria = await locator.getAttribute('aria-label').catch(() => null);
  if (aria && aria.trim()) return aria.replace(/\s+/g, ' ').trim().slice(0, 160);
  const text = await locator.evaluate((el) => {
    if (el.matches('button.invisibutton')) {
      const parent = el.parentElement;
      const navigation = { navBtn_next: 'Next', navBtn_back: 'Previous', navBtn_menu: 'Home', navBtn_exit: 'Exit', navBtn_help: 'Help' };
      if (navigation[parent?.id]) return navigation[parent.id];
      if (/^menuscreen_panel_\d+$/.test(parent?.id || '')) {
        const title = parent.querySelector('[class^=menuTopicButtonClosed]')?.textContent?.trim();
        const status = parent.querySelector('.topicStatus')?.className?.replace('topicStatus', '').trim();
        if (title) return `Open topic: ${title}${status ? ` (${status})` : ''}`;
      }
      if (parent?.matches('.menuStartBtn')) return 'Start';
      if (parent?.classList?.contains('screenElement')) {
        return { screenElement: true, id: parent.id || '', className: String(parent.className || '') };
      }
    }
    const id = el.getAttribute('id');
    const explicit = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = el.closest('label');
    const name = (explicit?.textContent || wrapping?.textContent || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value') || el.querySelector('img')?.getAttribute('alt') || el.querySelector('[title]')?.getAttribute('title') || ((el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle') || el.hasAttribute('aria-controls')) ? `Open panel: ${el.getAttribute('aria-controls') || el.getAttribute('data-target') || el.getAttribute('href') || 'course detail'}` : ''));
    if (String(name).trim()) return name;
    if (el.matches('img.dki-element-content.hasRollover') && getComputedStyle(el).cursor === 'pointer') {
      const icons = Array.from(el.ownerDocument.querySelectorAll('img.dki-element-content.hasRollover')).filter(icon => icon.getClientRects().length && getComputedStyle(icon).visibility !== 'hidden' && getComputedStyle(icon).cursor === 'pointer');
      return `Course information icon ${icons.indexOf(el) + 1}`;
    }
    return '';
  }).catch(() => '');
  if (text && typeof text === 'object' && text.screenElement) {
    return screenElementControlName(text.id, text.className).slice(0, 160);
  }
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function isSubmitControl(locator) {
  return locator.evaluate((el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit' || type === 'image') return true;
    return el.tagName === 'BUTTON' && type !== 'button' && Boolean(el.closest('form'));
  }).catch(() => true);
}

async function visibleFrames(page) {
  const frames = [];
  for (const frame of page.frames().slice(0, 16)) {
    if (frame.parentFrame() && !await frame.frameElement().then((element) => element.isVisible()).catch(() => false)) continue;
    frames.push(frame);
  }
  return frames;
}

async function readControls(page, role, prefix, navigationOnly, mode = 'read') {
  const listed = [];
  const handles = new Map();
  for (const frame of await visibleFrames(page)) {
    const locator = navigationOnly ? frame.locator('button, a, [role=button], [role=tab], summary, [onclick], [data-toggle], [data-bs-toggle], [aria-controls], input[type=button], input[type=submit], input[type=image], .dki-element-content.speech-bubble, img.dki-element-content.hasRollover') : frame.getByRole(role);
    const indices = await locator.evaluateAll(elements => {
      const indices = [];
      for (let index = 0; index < elements.length; index += 1) {
        const el = elements[index];
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!el.getClientRects().length || !rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        if (el.matches('.dki-element-content.speech-bubble, img.dki-element-content.hasRollover') && style.cursor !== 'pointer') continue;
        let facing = true;
        for (let face = el; face; face = face.parentElement) {
          if (getComputedStyle(face).backfaceVisibility !== 'hidden') continue;
          let matrix = new DOMMatrix();
          for (let node = face; node; node = node.parentElement) {
            const transform = getComputedStyle(node).transform;
            if (transform !== 'none') matrix = new DOMMatrix(transform).multiply(matrix);
          }
          if (matrix.m33 < -0.001) { facing = false; break; }
        }
        if (!facing) continue;
        indices.push(index);
        if (indices.length >= 120) break;
      }
      return indices;
    }).catch(() => []);
    for (const index of indices) {
      const handle = locator.nth(index);
      if (!await handle.isVisible().catch(() => false) || !await handle.isEnabled().catch(() => false)) continue;
      const name = await accessibleName(handle);
      if (!name || (navigationOnly && UNSAFE_LABEL.test(name))) continue;
      let kind;
      if (navigationOnly) {
        const submits = await isSubmitControl(handle);
        // Next/Save form controls advance quiz pages; their form type alone
        // does not make them a final submission. Read mode refuses both.
        kind = SUBMIT_LABEL.test(name) ? 'submission' : submits || ASSESSMENT_START_LABEL.test(name) || /^(save|return later|summary)\b/i.test(name) ? 'quiz-navigation' : 'content';
        if (mode !== 'quiz' && (kind === 'submission' || kind === 'quiz-navigation')) continue;
        const safeLink = await handle.evaluate(el => {
          if (el.tagName !== 'A') return true;
          const href = el.getAttribute('href') || '';
          if (/^javascript:\s*(?:void\s*\(\s*0\s*\)\s*;?|;)$/i.test(href.trim())) return true;
          return !/^(javascript|mailto|tel|data):/i.test(href) && !/\b(logout|signout|delete|purchase|checkout|account|login)\b/i.test(href);
        }).catch(() => false);
        if (!safeLink) continue;
      }
      const id = `${prefix}${listed.length + 1}`;
      handles.set(id, handle);
      listed.push({ id, name, ...(kind ? { kind } : {}) });
      if (listed.length >= 40) return { listed, handles };
    }
  }
  return { listed, handles };
}

async function readSnapshot(page, mode = 'read') {
  const sections = [];
  for (const frame of await visibleFrames(page)) {
    try {
      const observed = await frame.evaluate(() => {
        const visible = (el, inViewport = true) => {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          if (!r.width || !r.height || s.display === 'none' || s.visibility === 'hidden' || !el.getClientRects().length) return false;
          if (inViewport && !(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return false;
          for (let face = el; face; face = face.parentElement) {
            if (getComputedStyle(face).backfaceVisibility !== 'hidden') continue;
            let matrix = new DOMMatrix();
            for (let node = face; node; node = node.parentElement) {
              const transform = getComputedStyle(node).transform;
              if (transform !== 'none') matrix = new DOMMatrix(transform).multiply(matrix);
            }
            if (matrix.m33 < -0.001) return false;
          }
          return true;
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const lines = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!parent || parent.closest('script,style,noscript') || !visible(parent)) continue;
          const value = node.textContent.replace(/\s+/g, ' ').trim();
          if (value) lines.push(value);
        }
        const headings = Array.from(document.querySelectorAll('h1,h2,[role=heading]'));
        const heading = headings.find(el => visible(el)) || headings.find(el => visible(el, false));
        return { heading: heading?.textContent?.trim() || document.title, text: lines.join('\n'), position: Math.round(scrollY), end: scrollY + innerHeight >= document.documentElement.scrollHeight - 2 };
      });
      if (!observed.text.trim()) continue;
      const source = frame.url().split(/[?#]/)[0].slice(0, 500);
      sections.push(`[Source: ${source} | ${observed.heading || ''} | scroll ${observed.position}${observed.end ? ' | end of page' : ''}]\n${observed.text}`);
    } catch {
      // A cross-origin frame has no readable body.
    }
  }
  const buttons = await readControls(page, 'button', 'b', true, mode);
  const radios = await readControls(page, 'radio', 'c', false);
  const checks = await readControls(page, 'checkbox', 'k', false);
  const handles = new Map([...buttons.handles, ...radios.handles, ...checks.handles]);
  const tabs = [];
  // Only already-observed course tabs on this website are offered. There is
  // no model-supplied URL, browser-wide arbitrary selection or navigation.
  try {
    const origin = new URL(page.url()).origin;
    if (/^https?:/.test(page.url())) for (const candidate of page.context().pages()) {
      if (candidate === page || tabs.length >= 20 || new URL(candidate.url()).origin !== origin) continue;
      const name = (await candidate.title()).slice(0,160);
      if (UNSAFE_LABEL.test(name) || /\b(logout|login|account|checkout|delete)\b/i.test(candidate.url())) continue;
      const path = new URL(candidate.url()).pathname;
      if (!/course|lesson|module|quiz|assessment|curriculum|training|paper|learning/i.test(`${name} ${path}`)
        && !/\/(?:lms|scorm|evaluation)(?:\/|$)/i.test(path)) continue;
      const id = `t${tabs.length + 1}`;
      tabs.push({id,name:name || 'Course page',url:candidate.url().slice(0,500)});
      handles.set(id,{page:candidate,url:candidate.url(),name});
    }
  } catch { /* A tab closing during observation is not a selectable target. */ }
  return {
    snapshot: {
      title: (await page.title().catch(() => '')).slice(0,200),
      url: page.url().slice(0,500),
      text: `${await observePlayerEvidence(page)}\n${sections.map(section => section.slice(0, Math.floor(7600 / Math.max(1, sections.length)))).join('\n')}`.slice(0, 8000),
      buttons: buttons.listed,
      choices: [...radios.listed, ...checks.listed],
      tabs,
    },
    handles,
  };
}

function sameLearnerView(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function createActionReader() {
  const rl = readline.createInterface({ input: process.stdin });
  const pending = [];
  const failAll = (error) => {
    while (pending.length) pending.shift().reject(error);
  };
  rl.on('line', (line) => {
    const waiter = pending.shift();
    if (!waiter) return;
    if (line.startsWith('LEARNER_STOP ')) {
      waiter.reject(new Error(line.slice('LEARNER_STOP '.length)));
      return;
    }
    if (!line.startsWith('LEARNER_ACTION ')) {
      waiter.reject(new Error('Unexpected learner response'));
      return;
    }
    try {
      waiter.resolve(JSON.parse(line.slice('LEARNER_ACTION '.length)));
    } catch {
      waiter.reject(new Error('Learner action was not JSON'));
    }
  });
  rl.on('close', () => failAll(new Error('Learner input closed')));
  process.stdin.on('error', () => failAll(new Error('Learner input closed')));
  return {
    request: (snapshot) => new Promise((resolve, reject) => {
    const entry = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      reject(new Error('Learner input timed out'));
    }, 45_000);
    pending.push(entry);
    process.stdout.write(`LEARNER_SNAPSHOT ${JSON.stringify(snapshot)}\n`);
    }),
    close: () => rl.close(),
  };
}

async function applyAction(page, action, snapshot, handles, mode = 'read', retryState = { count: 0 }) {
  if (!localActionAllowed(action, snapshot, mode)) throw new Error('Learner action is not allowed');
  if (action.action === 'select-tab') {
    const target = handles.get(action.targetId);
    const observed = snapshot.tabs?.find(tab => tab.id === action.targetId);
    if (!target?.page || target.page.isClosed() || target.page.url() !== target.url || target.url !== observed?.url || await target.page.title() !== target.name) throw new Error('Learner tab changed');
    if (new URL(page.url()).origin !== new URL(target.url).origin) throw new Error('Learner tab website changed');
    await target.page.bringToFront();
    return target.page;
  }
  if (action.action === 'scroll') {
    // Scroll each visible course frame as well as the outer wrapper.
    for (const frame of await visibleFrames(page)) await frame.evaluate(() => window.scrollBy(0, Math.max(300, innerHeight * 0.8))).catch(() => undefined);
    await page.waitForTimeout(100);
    return;
  }
  if (action.action === 'wait') {
    const ms = Math.max(0, Math.min(1000, Number(action.ms) || 500));
    await page.waitForTimeout(ms);
    return;
  }
  if (action.action === 'capture') {
    console.log(`Captured quiz view: ${snapshot.title || snapshot.url}`);
    return;
  }
  const handle = handles.get(action.targetId);
  if (!handle) throw new Error('Learner target is not on the page');
  const target = [...(snapshot.buttons || []), ...(snapshot.choices || [])].find(item => item.id === action.targetId);
  if (!await handle.isVisible() || !await handle.isEnabled() || await accessibleName(handle) !== target?.name) throw new Error('Learner target changed');
  if (action.action === 'click') {
    if (mode === 'quiz' && RETRY_LABEL.test(target.name)) {
      if (retryState.count >= MAX_QUIZ_RETRIES) {
        const error = new Error('Quiz retry limit reached');
        error.code = 'LEARNER_RETRY_LIMIT';
        throw error;
      }
      retryState.count += 1;
    }
    await handle.click({ timeout: 5000 });
    return;
  }
  await handle.check({ timeout: 5000 });
}

async function emitQuestion(payload, snapshot, browser) {
  const tabs = await Promise.all(browser.contexts()[0].pages().map(async (page, idx) => ({ idx, url: page.url(), title: await page.title().catch(() => "") })));
  console.log(`LEARNER_TABS ${JSON.stringify(tabs)}`);
  console.log(learnerQuestionLine({ ...payload, url: snapshot.url }));
  finish(false, LEARNER_NEEDS_INPUT);
}

function finish(completed, reason) {
  const payload = completed
    ? { completed: 1, total: 1 }
    : { completed: 0, total: 1, failures: [{ title: 'quiz-learn', reason: reason || 'learner-stopped' }] };
  console.log(`AUTOMATION_RESULT ${JSON.stringify(payload)}`);
  if (!completed) process.exitCode = 1;
}

async function main() {
  const options = parseLearnQuizArgs(process.argv);
  const mode = process.env.VITRIOL_LEARNER_MODE === 'quiz' ? 'quiz' : 'read';
  const browser = await chromium.connectOverCDP(CDP_URL);
  let reader = null;
  try {
    let page = browser.contexts()[0]?.pages()?.[options.tabIdx];
    if (!page) throw new Error('Tab index is not open');
    if (options.dryRun) {
      const { snapshot } = await readSnapshot(page, mode);
      console.log(`Dry run: quiz-learn observed "${snapshot.title || 'untitled'}"`);
      return;
    }
    reader = createActionReader();
    let repeatState = null;
    const retryState = { count: 0 };
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const { snapshot, handles } = await readSnapshot(page, mode);
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: `Reading ${snapshot.title || 'the current course page'}.` })}`);
      if (mode === 'quiz' && pageShowsPass(snapshot)) { finish(true); return; }
      const action = await reader.request(snapshot);
      if (!localActionAllowed(action, snapshot, mode)) {
        finish(false, 'rejected-action');
        return;
      }
      if (action.action === 'ask-user') {
        const question = learnerQuestionPayload(snapshot, action);
        if (!question) {
          finish(false, 'rejected-action');
          return;
        }
        await emitQuestion(question, snapshot, browser);
        return;
      }
      let view = snapshot;
      let viewHandles = handles;
      if (action.action !== 'verify') {
        const current = await readSnapshot(page, mode);
        if (!sameLearnerView(snapshot, current.snapshot)) {
          console.log(`Learner step ${step}: page changed while deciding; inspecting again`);
          continue;
        }
        view = current.snapshot;
        viewHandles = current.handles;
      }
      const repeated = noteRepeatedLearnerAction(repeatState, action, view);
      repeatState = repeated.state;
      if (repeated.question) {
        console.log(`Learner step ${step}: repeated unchanged ${action.action}`);
        await emitQuestion(repeated.question, view, browser);
        return;
      }
      if (action.action === 'verify') {
        if (mode !== 'quiz' || !pageShowsPass(snapshot)) {
          console.log(`Learner step ${step}: page does not show a pass`);
          continue;
        }
        finish(true);
        return;
      }
      const popup = action.action === 'click' ? page.waitForEvent('popup', { timeout: 2500 }).catch(() => null) : null;
      let switched;
      try { switched = await applyAction(page, action, view, viewHandles, mode, retryState); }
      catch (error) {
        if (error.code !== 'LEARNER_RETRY_LIMIT') throw error;
        await emitQuestion({question:'Two quiz retries have been started in this run and the feedback has been retained. What should I review or change before another attempt?'}, view, browser);
        return;
      }
      if (switched) page = switched;
      const opened = popup ? await popup : null;
      if (opened) {
        if (!/^https?:/i.test(opened.url())) await opened.waitForURL(url => /^https?:$/.test(url.protocol), {timeout:10_000}).catch(() => undefined);
        await opened.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        page = opened;
        console.log('Following the course window opened by the selected control');
      }
      const target = [...(view.buttons || []), ...(view.choices || []), ...(view.tabs || [])].find((item) => item.id === action.targetId);
      const activity = action.action === 'select-tab' ? `Switched to ${target?.name || 'the selected course page'}.` : action.action === 'click' ? (target?.name?.startsWith('Course interaction:') ? 'Opened an interactive part of the course.' : `Opened ${target?.name || 'the selected control'}.`) : action.action === 'answer-select' ? `Selected ${target?.name || 'an answer'}.` : action.action === 'scroll' ? 'Scrolled to look for more course content.' : 'Checking the current page.';
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: activity })}`);
      console.log(`Learner step ${step}: ${action.action}`);
    }
    finish(false, 'step-cap');
  } finally {
    reader?.close();
    await browser.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    finish(false, 'learner-error');
  });
}

module.exports = {
  parseLearnQuizArgs,
  localActionAllowed,
  pageShowsPass,
  learnerQuestionPayload,
  learnerQuestionLine,
  LEARNER_NEEDS_INPUT,
  accessibleName,
  readControls,
  readSnapshot,
  applyAction,
  visibleFrames,
  sameLearnerView,
  clickLabelAllowed,
  screenElementControlName,
  noteRepeatedLearnerAction,
};
