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
// view requests coordination once, then pauses after bounded retries. Guidance is
// not a shell argument.
// Unsupported launch links remain blocked, with bounded control-name diagnostics
// in progress and observation text; no script URLs are evaluated as a fallback.
// Current visible pass/fail results end the attempt before another model call
// or repeated-action prompt, preserving the observed score and feedback.
// Radio buttons and checkboxes share one viewport-first 40-choice budget.
// Hidden persistent slides never consume the visible-control scan budget;
// transformed-away flipcard faces and hidden headings are not observations.
// Read-only DOM family markers support source-linked player knowledge; they
// never authorize actions, identify an exact version or provide quiz answers.
// Checked choices prevent duplicate selection. Scroll/find operate on observed
// content; capture supplies one privacy-checked viewport JPEG to the next step.
// Course outlines include unvisited headings as inventory, never read coverage.
// Canon instruction panels name a hotspot only when one visible target and
// one emphasized instruction subject exist on the same slide.
// Brainshark requirements are checked before playback. Listening requires an
// explicit operator reply scoped to the current conversation and presentation.
// Approved playback is monitored locally, including inline questions and the
// real Saba completion result. Written answers use observed course fields only.
// Saba matching uses observed dropdowns/options, verified selections and fresh
// question identities. Native result finalization still requires Saba success.
// Terminal direct Storyline wrappers use scoped, ordinary course exits, commit
// only existing completion, and verify the LMS result before reporting success.
// Animation-only navigation rechecks use local semantic slide/target identity;
// question, choice, selection and genuine content changes remain significant.
// Brightwave authored text uses bounded same-publication reads and normal scoped
// memory, including observed Waveform html/course.htm manifests. Grouped answers
// use scroll-independent semantic/control identity, preflight and DOM verification.
//
// Usage:
//   node pw-learn-quiz.js <tabIdx> [--dry]

const readline = require('node:readline');
const { createHash, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { observePlayerEvidence } = require('./lib/player-evidence');
const { recognizeQuizResult, quizResultPayload } = require('./lib/quiz-result');
const { readBrainshark, listeningQuestion, playbackApproved, playbackControl, setPlaybackSpeed, closeBrainsharkReaders, CONTINUE_LISTENING_QUESTION } = require('./lib/brainshark-player');
const { launchSelectedCourse, originatingSabaPage, finishSabaCourse, protectSabaPopups, sabaAddress, currentCourseSuccessful } = require('./lib/course-launch');
const {certificationAddress,runCertificationLearning}=require('./lib/certification-learning');
const { COURSE_EXIT_LABEL, createStorylineFinalizer } = require('./lib/storyline-finalization');
const {storylineRoot,collectStorylineMaterial}=require('./lib/storyline-material');
const { publicationRoot, collectAuthoredMaterial } = require('./lib/authored-material');
const { watchCoursePopup } = require('./lib/course-popup');
const { captureStableViewport } = require('./lib/stable-viewport-capture');
const { browserTargetId, listBrowserTabs, selectBrowserPage } = require('./lib/browser-tabs');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const MAX_STEPS = 80;
const SUBMIT_LABEL = /\b(submit|finish|end test|end quiz|grade)\b/i;
const UNSAFE_LABEL = /\b(log\s*out|sign\s*out|sign\s*in|log\s*in|password|account|payment|purchase|buy|delete|remove|unsubscribe|exit|close browser)\b/i;
const ASSESSMENT_START_LABEL = /\b(?:(?:start|begin|launch|take)(?:\s+the)?\s+(?:test|quiz|assessment)|retake|retry)\b/i;
const NAVIGATION_LABEL = /^(next(?: page| slide)?|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch(?: course| module)?|resume|menu|home|contents)$/i;
const OPEN_TOPIC_LABEL = /^Open topic: .{1,140}$/;
const COURSE_INTERACTION_LABEL = /^Course interaction: \d+_\d+_click_?\d+$/;
const COURSE_PLAYER_LABEL = /^Course player: (?:Exit|Confirm exit|Cancel exit)$/;
const REPEATED_VIEW_LIMIT = 3;
const REPEATED_VIEW_OPTION = 'Done, resume now';
const ALLOWED = new Set(['click', 'answer-select', 'answer-text', 'answer-group', 'select-tab', 'scroll', 'find-text', 'wait', 'capture', 'verify', 'ask-user']);
const observationState = new WeakMap();
const matchingTargets = new WeakMap();
const MAX_CAPTURE_DATA_URL = 900_000;
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
  return recognizeQuizResult(snapshot)?.status === 'passed';
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
  return NAVIGATION_LABEL.test(trimmed) || OPEN_TOPIC_LABEL.test(trimmed) || COURSE_INTERACTION_LABEL.test(trimmed) || COURSE_PLAYER_LABEL.test(trimmed);
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
  return `${name}\u0000${targetId}\u0000${name === 'scroll' ? action?.direction || 'down' : ''}\u0000${action?.text || ''}\u0000${JSON.stringify(action?.answers || [])}`;
}

function validAnswerGroup(action, snapshot, mode) {
  if (mode !== 'quiz' || !/^[a-f0-9]{64}$/.test(action.pageId || '') || action.pageId !== snapshot.answerPageId
    || !Array.isArray(action.answers) || action.answers.length < 1 || action.answers.length > 8) return false;
  const seen = new Set(), radios = new Set();
  for (const answer of action.answers) {
    if (!answer || typeof answer !== 'object' || seen.has(answer.targetId)) return false;
    seen.add(answer.targetId);
    const choice = snapshot.choices?.find(control => control.id === answer.targetId);
    const field = snapshot.fields?.find(control => control.id === answer.targetId);
    if (choice && ['radio','checkbox'].includes(choice.answerKind) && choice.groupId && typeof answer.checked === 'boolean' && answer.text == null) {
      if (choice.answerKind === 'radio') {
        if (!answer.checked || radios.has(choice.groupId)) return false;
        radios.add(choice.groupId);
      }
    } else if (!(field && answer.checked == null && typeof answer.text === 'string' && answer.text.trim() && answer.text.length <= 2000)) return false;
  }
  return true;
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
  if (action.action === 'answer-group') return validAnswerGroup(action, snapshot, mode);
  if (action.action === 'scroll') return action.direction == null || action.direction === 'up' || action.direction === 'down';
  if (action.action === 'find-text') return typeof action.text === 'string' && action.text.trim().length > 0 && action.text.length <= 160;
  if (action.action === 'ask-user') return learnerQuestionPayload(snapshot, action) != null;
  if (action.action === 'answer-text') return mode === 'quiz' && /^f\d{1,3}$/.test(action.targetId)
    && snapshot.fields?.some(field => field.id === action.targetId) && typeof action.text === 'string'
    && action.text.trim().length > 0 && action.text.length <= 2000;
  if (action.action === 'select-tab') {
    const target = snapshot.tabs?.find(tab => tab.id === action.targetId);
    if (!target || !/^t\d{1,3}$/.test(action.targetId) || UNSAFE_LABEL.test(target.name)) return false;
    try { const current = new URL(snapshot.url); return /^https?:$/.test(current.protocol) && new URL(target.url).origin === current.origin; } catch { return false; }
  }
  if (action.action === 'click' || action.action === 'answer-select') {
    const pool = action.action === 'click' ? snapshot.buttons : snapshot.choices;
    const target = (pool || []).find((item) => item.id === action.targetId);
    if (!target) return false;
    if (action.action === 'answer-select' && target.checked === true) return false;
    if (action.action === 'click') {
      if (mode === 'quiz' && recognizeQuizResult(snapshot)) return false;
      if (/^m\d+$/.test(target.id) && target.kind === 'quiz-navigation') return mode === 'quiz';
      if (!COURSE_PLAYER_LABEL.test(target.name) && (UNSAFE_LABEL.test(target.name) || COURSE_EXIT_LABEL.test(target.name))) return false;
      const radios = (snapshot.choices || []).filter(choice => /^c\d+$/.test(choice.id));
      if (mode === 'quiz' && /^(?:(?:go to )?next(?: question| page| slide)?[ »›→]*|submit|finish|end test)$/i.test(target.name.trim())
        && snapshot.buttons?.some(control => control.selection?.answered === false)) return false;
      if (mode === 'quiz' && /^(?:go to )?next(?: question| page| slide)?[ »›→]*$/i.test(target.name.trim()) && /\bQuestion\s+\d+\s+of\s+\d+\b/i.test(snapshot.text || '')
        && radios.length > 0 && radios.every(choice => choice.checked === false)) return false;
      if (ASSESSMENT_START_LABEL.test(target.name)) return mode === 'quiz';
      if (SUBMIT_LABEL.test(target.name) || target.kind === 'submission' || target.kind === 'quiz-navigation') return mode === 'quiz';
      if (!['content', 'navigation'].includes(target.kind) && !clickLabelAllowed(target.name)) return false;
    }
  }
  return true;
}

// This function runs inside the page. Only the observed DKI base/rollover pair
// is treated as one logical image; it does not authorize hidden activation.
function dkiInformationIcon(el) {
  const doc = el.ownerDocument;
  const baseSelector = 'img.dki-element-content.hasRollover';
  const linkedClone = base => {
    const match = /^content_(\d+)$/.exec(base.id);
    if (!match) return null;
    const clone = doc.getElementById(`${base.id}_rollover`);
    return clone?.matches('img.dki-element-content.dki-image-rollover[data-id]') && clone.getAttribute('data-id') === match[1] ? clone : null;
  };
  let base = el.matches(baseSelector) ? el : null;
  if (!base && el.matches('img.dki-element-content.dki-image-rollover[data-id]') && /^\d+$/.test(el.getAttribute('data-id') || '')) {
    base = doc.getElementById(`content_${el.getAttribute('data-id')}`);
    if (!base?.matches(baseSelector) || linkedClone(base) !== el) return null;
  }
  if (!base || getComputedStyle(base).cursor !== 'pointer') return null;
  const rendered = icon => icon && icon.getClientRects().length && getComputedStyle(icon).visibility !== 'hidden' && icon.getBoundingClientRect().width > 0 && icon.getBoundingClientRect().height > 0;
  const icons = Array.from(doc.querySelectorAll(baseSelector)).filter(icon => getComputedStyle(icon).cursor === 'pointer' && (rendered(icon) || rendered(linkedClone(icon))));
  const index = icons.indexOf(base);
  return index >= 0 ? {name:`Course information icon ${index + 1}`} : null;
}

async function simulationControlName(locator, name) {
  if (!/^(?:log\s*in|sign\s*in|logmein)$/i.test(name)) return name;
  const simulated = await locator.evaluate(el => location.origin === 'https://canon-europe.csod.com'
    && /^\/content\/canon-europe\/publications\/\d+\//.test(location.pathname)
    && el.matches('button.invisibutton') && Boolean(el.closest('.screenElement'))
    && /\bSIMS\b/i.test(el.ownerDocument.body.innerText)
    && !el.closest('form') && !el.ownerDocument.querySelector('input[type=password]')).catch(()=>false);
  return simulated ? 'Course simulation: SIMS example entry' : name;
}

async function accessibleName(locator) {
  const aria = await locator.getAttribute('aria-label').catch(() => null);
  if (aria && aria.trim()) return simulationControlName(locator, aria.replace(/\s+/g, ' ').trim().slice(0, 160));
  const text = await locator.evaluate((el) => {
    const labelledBy = el.getAttribute('aria-labelledby')?.trim();
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      if (label) return label;
    }
    if (el.matches('button.invisibutton')) {
      const parent = el.parentElement;
      const publication = typeof location !== 'undefined' && location.origin === 'https://canon-europe.csod.com'
        && /^\/content\/canon-europe\/publications\/\d+\/lib_[a-z-]+\/(?:html|templates)\//i.test(location.pathname);
      if (publication) {
        if (parent?.id === 'navBtn_exit') return 'Course player: Exit';
        if (parent?.id === 'exit_yesBtn' && /^Yes$/i.test(parent.querySelector('.btn p')?.textContent.trim() || '')) return 'Course player: Confirm exit';
        if (parent?.id === 'exit_noBtn' && /^No$/i.test(parent.querySelector('.btn p')?.textContent.trim() || '')) return 'Course player: Cancel exit';
      }
      const navigation = { navBtn_next: 'Next', navBtn_back: 'Previous', navBtn_menu: 'Home', navBtn_exit: 'Exit', navBtn_help: 'Help' };
      if (navigation[parent?.id]) return navigation[parent.id];
      if (/^menuscreen_panel_\d+$/.test(parent?.id || '')) {
        const title = parent.querySelector('[class*=menuTopicButton]')?.textContent?.trim();
        const status = parent.querySelector('.topicStatus')?.className?.replace('topicStatus', '').trim();
        if (title) return `Open topic: ${title}${status ? ` (${status})` : ''}`;
      }
      if (parent?.matches('.menuStartBtn')) {
        const panel = parent.closest?.('[id^=menuscreen_panel_]');
        const title = panel?.querySelector('[class*=menuTopicButton]')?.textContent?.trim();
        return title ? `Open topic: ${title} - Start` : 'Start';
      }
      if (parent?.classList?.contains('screenElement')) {
        const slide = /^(\d+_\d+)_click_?\d+$/.exec(parent.id || '');
        if (slide && parent.ownerDocument) {
          const visible = node => {
            if (!node || !node.getClientRects().length) return false;
            for (let item = node; item?.nodeType === 1; item = item.parentElement) {
              const style = getComputedStyle(item);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            }
            return true;
          };
          const panel = parent.ownerDocument.getElementById(`${slide[1]}_instruction_panel`);
          const targets = Array.from(parent.ownerDocument.querySelectorAll('.screenElement.box')).filter(node =>
            new RegExp(`^${slide[1]}_click_?\\d+$`).test(node.id) && visible(node) && node.querySelector('button.invisibutton'));
          const subjects = panel && visible(panel) ? Array.from(panel.querySelectorAll('.instructionText b, .instructionText strong')).filter(visible) : [];
          const subject = subjects.length === 1 ? subjects[0].textContent.replace(/\s+/g, ' ').trim() : '';
          if (targets.length === 1 && targets[0] === parent && subject && subject.length <= 120) return `Open topic: ${subject}`;
        }
        if (parent.classList.contains('box') && /^[\w-]{1,96}$/.test(parent.id || '') && !/wrong|incorrect|blocker/i.test(parent.id)) {
          const known = /^\d+_\d+_click_?\d+$/.test(parent.id) || parent.classList.contains('backbtn') || parent.classList.contains('nextbtn');
          if (!known) return `Course hotspot: ${parent.id}`;
        }
        return { screenElement: true, id: parent.id || '', className: String(parent.className || '') };
      }
    }
    const id = el.getAttribute('id');
    const explicit = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = el.closest('label');
    const name = (explicit?.textContent || wrapping?.textContent || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value') || el.querySelector('img')?.getAttribute('alt') || el.querySelector('[title]')?.getAttribute('title') || ((el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle') || el.hasAttribute('aria-controls')) ? `Open panel: ${el.getAttribute('aria-controls') || el.getAttribute('data-target') || el.getAttribute('href') || 'course detail'}` : ''));
    if (String(name).trim()) return name;
    return '';
  }).catch(() => '');
  if (text && typeof text === 'object' && text.screenElement) {
    return screenElementControlName(text.id, text.className).slice(0, 160);
  }
  const normalized = String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
  return normalized ? simulationControlName(locator, normalized) : (await locator.evaluate(dkiInformationIcon).catch(() => null))?.name || '';
}

async function controlName(handle) {
  const name = await accessibleName(handle);
  if (!name || /^Rectangle \d+$/i.test(name)) {
    const label = await handle.evaluate(el => {
      if (!el.matches('input.acc-shadow-el[data-represents],button.acc-shadow-el[data-represents]')) return '';
      const parts = el.getAttribute('data-represents').split('.');
      const id = parts.pop();
      if (parts.at(-1) === id) parts.pop();
      if (parts.length < 2) return '';
      const scope = `${parts.join('.')}.`;
      const row = el.getBoundingClientRect();
      const isAnswer = el.tagName === 'INPUT';
      const selector = isAnswer ? '.acc-text[data-represents],button.acc-shadow-el.acc-button[data-represents]' : '.acc-text[data-represents]';
      const labels = [...el.ownerDocument.querySelectorAll(selector)]
        .filter(candidate => {
          if (candidate === el || !candidate.getAttribute('data-represents').startsWith(scope)
            || !candidate.checkVisibility({checkVisibilityCSS:true})) return false;
          const rect = candidate.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const y = rect.top + rect.height / 2;
          if (isAnswer) return rect.left >= row.right && rect.left - row.right < row.width * 2
            && Math.abs(y - (row.top + row.height / 2)) < row.height / 3;
          const x = rect.left + rect.width / 2;
          return x > row.left && x < row.right && y > row.top && y < row.bottom
            && rect.width <= row.width * 1.2 && rect.height <= row.height;
        }).map(candidate => candidate.textContent.replace(/\s+/g, ' ').trim())
        .filter(text => text && !/^Rectangle \d+$/i.test(text) && !/[\uE000-\uF8FF]/.test(text));
      const distinct = [...new Set(labels)];
      return distinct.length === 1 ? distinct[0] : '';
    }).catch(() => '');
    if (label) return label.slice(0, 160);
  }
  return name;
}

async function answerName(handle) {
  const name = await controlName(handle);
  if (!name) return '';
  const question = await handle.evaluate(el => {
    const block = el.closest('fieldset.testEngine-question')?.parentElement;
    return block?.innerText?.trim().match(/^Question\s+(\d+)\s+of\s+\d+\b/i)?.[1];
  }).catch(() => undefined);
  return question ? `Q${question}: ${name}`.slice(0,160) : name;
}

// Runs in the course frame. Match the topmost graphic to the exact observed
// control, including a nested SVG shape inside the control's state group.
function storylineGraphic(el, findDuplicate = false) {
  const graphicAt = control => {
    const id = control.getAttribute('data-represents')?.split('.').at(-1);
    if (!id) return null;
    const rect = control.getBoundingClientRect();
    for (const [fx, fy] of [[.5, .5], [.35, .5], [.65, .5], [.5, .35], [.5, .65]]) {
      const hit = control.ownerDocument.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      const object = hit?.closest(`.slide-object[data-model-id="${CSS.escape(id)}"]`);
      const eventTarget = hit?.closest('svg .eventable');
      if (object && eventTarget && object.contains(eventTarget)) return { fx, fy };
    }
    return null;
  };
  if (!el.matches('button.acc-shadow-el[data-represents],input.acc-shadow-el[data-represents][type=radio],input.acc-shadow-el[data-represents][type=checkbox]')) return null;
  if (!findDuplicate) return graphicAt(el);
  if (graphicAt(el)) return false;
  const point = el.getBoundingClientRect();
  return [...el.ownerDocument.querySelectorAll('button.acc-shadow-el[data-represents]')].some(candidate => {
    if (candidate === el || candidate.textContent.trim() !== el.textContent.trim()) return false;
    const rect = candidate.getBoundingClientRect();
    return Math.abs(rect.x - point.x) < 1 && Math.abs(rect.y - point.y) < 1
      && Math.abs(rect.width - point.width) < 1 && Math.abs(rect.height - point.height) < 1
      && Boolean(graphicAt(candidate));
  });
}

class CourseControlBlocked extends Error {}
class GroupedAnswerChanged extends CourseControlBlocked {}

async function clickStorylineControl(page, handle, point, answer) {
  const element = await handle.elementHandle({ timeout: 800 });
  const [frame, identity] = await Promise.all([
    element.ownerFrame(),
    element.evaluate(el => ({ id: el.id, model: el.getAttribute('data-represents') })),
  ]).finally(() => element.dispose());
  if (!frame || !/^[\w-]+$/.test(identity.id)) throw new CourseControlBlocked('The course control has no stable identity');
  const current = frame.locator(`[id="${identity.id}"]`);
  const isSame = () => current.evaluate((el, model) => el.getAttribute('data-represents') === model, identity.model, { timeout: 800 });
  if (answer && await current.isChecked({ timeout: 800 })) return;

  async function position(fraction) {
    const box = await current.boundingBox({ timeout: 800 });
    if (!box) return null;
    return { x: box.x + box.width * fraction.fx, y: box.y + box.height * fraction.fy };
  }
  const initial = await position(point);
  if (!initial) throw new CourseControlBlocked('The course control disappeared');
  await page.mouse.move(initial.x, initial.y);

  // Hover can replace Storyline's SVG. Re-read the same accessibility element
  // and require its graphic to still own the pointer before sending down/up.
  const fresh = await current.evaluate(storylineGraphic, false, { timeout: 800 });
  const hit = fresh && await position(fresh);
  if (!hit || !await isSame() || Math.hypot(initial.x - hit.x, initial.y - hit.y) > 1) {
    throw new CourseControlBlocked('The course control changed under the pointer');
  }
  for (let child = frame; child.parentFrame(); child = child.parentFrame()) {
    const host = await child.frameElement();
    try {
      const bounds = await host.boundingBox();
      if (!bounds || !await host.evaluate((el, ratio) => {
        const rect = el.getBoundingClientRect();
        return el.ownerDocument.elementFromPoint(rect.x + rect.width * ratio.x, rect.y + rect.height * ratio.y) === el;
      }, {x: (initial.x - bounds.x) / bounds.width, y: (initial.y - bounds.y) / bounds.height})) {
        throw new CourseControlBlocked('Another element covers the course frame');
      }
    } finally { await host.dispose(); }
  }
  await page.mouse.down();
  await page.mouse.up();
  if (answer) {
    try {
      await current.filter({ visible: true }).and(frame.locator(':checked')).waitFor({ state: 'visible', timeout: 1000 });
      if (await isSame()) return;
    } catch { /* A redraw is allowed, but selection still needs proof. */ }
    throw new CourseControlBlocked('The answer selection could not be verified after the click');
  }
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

function canonicalCourseSource(value) {
  try {const url=new URL(value);return /^https?:$/.test(url.protocol)?`${url.origin}${url.pathname}`.slice(0,500):'';} catch {return '';}
}

async function readCourseOutlines(page) {
  const outlines=[];
  for(const frame of await visibleFrames(page)) {
    const url=canonicalCourseSource(await frame.evaluate(() => location.href).catch(() => frame.url()));
    if(!url || /(?:evallaunch|evaluation|assessment|quiz|exam)(?:[/.]|$)|\b(?:login\d*|signin|oauth|sso)\b/i.test(url)) continue;
    const inventory=await frame.evaluate(()=>{
      if(document.querySelector('input[type=password]') || /\bQuestion\s+\d+\s+of\s+\d+\b/i.test((document.body?.innerText||'').slice(0,2000))) return null;
      const topics=[];
      for(const el of document.querySelectorAll('h1,h2,h3,[role=heading]')) {
        const text=(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,160);
        if(!text || /^Question\s+\d+/i.test(text) || topics.includes(text)) continue;
        topics.push(text);if(topics.length>=60)break;
      }
      return topics.length?{title:(document.title||topics[0]).replace(/\s+/g,' ').trim().slice(0,160),topics}:null;
    }).catch(()=>null);
    if(inventory && !outlines.some(item=>item.url===url)) outlines.push({url,...inventory});
  }
  // Concrete content documents take precedence over generic LMS wrappers.
  outlines.sort((a,b)=>Number(/LMS\d*\.aspx|content-player/i.test(a.url))-Number(/LMS\d*\.aspx|content-player/i.test(b.url)));
  return outlines.slice(0,4);
}

function observationFor(page) {
  let state=observationState.get(page);
  if(!state){state={};observationState.set(page,state);}
  return state;
}

async function captureCurrentView(page) {
  const state=observationFor(page);delete state.image;delete state.imageUrl;
  const frames=page.frames();
  if(frames.length>32){state.feedback='Screenshot skipped: this page has too many frames to check safely.';return;}
  for(const frame of frames) {
    if(frame.parentFrame()&&!await frame.frameElement().then(el=>el.isVisible()).catch(()=>false))continue;
    const address=canonicalCourseSource(await frame.evaluate(() => location.href).catch(() => frame.url()));
    if(/\b(?:login\d*|signin|sign-in|oauth|sso|authenticate)\b/i.test(address)) {state.feedback='Screenshot skipped on an authentication page.';return;}
    const sensitive=frame.locator('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[name*=password i],input[id*=password i],input[name*=token i],input[id*=token i],input[name*=secret i],input[id*=secret i],input[name*=api_key i],input[id*=api_key i],input[name*=apikey i],input[id*=apikey i],textarea[name*=secret i],form[action*=login i],form[action*=signin i]');
    const count=await sensitive.count().catch(()=>-1);
    if(count<0 || count>50){state.feedback='Screenshot skipped: sensitive fields could not be checked safely.';return;}
    for(let index=0;index<count;index++) if(await sensitive.nth(index).isVisible().catch(()=>true)) {state.feedback='Screenshot skipped because an authentication or sensitive field is visible.';return;}
  }
  try {
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
    const jpeg=await captureStableViewport(page,viewport,'jpeg');
    const image=`data:image/jpeg;base64,${jpeg.toString('base64')}`;
    if(image.length>MAX_CAPTURE_DATA_URL){state.feedback='Screenshot skipped because the viewport image exceeds the size limit.';return;}
    state.image=image;state.imageUrl=page.url();state.imageIdentity={id:randomUUID(),...(state.questionId?{questionId:state.questionId}:{})};
    state.feedback='A viewport screenshot was captured for the current question/view.';
  } catch {state.feedback='The viewport screenshot was unavailable. Continue using the observed text and controls.';}
}

async function findRenderedText(page,text) {
  for(const frame of await visibleFrames(page)) {
    const matches=frame.getByText(text,{exact:false}).filter({visible:true});
    const count=Math.min(await matches.count().catch(()=>0),50);
    for(let index=0;index<count;index++) {
      const target=matches.nth(index);
      const facing=await target.evaluate(el=>{
        for(let face=el;face?.nodeType===1;face=face.parentElement) {
          if(getComputedStyle(face).backfaceVisibility!=='hidden')continue;
          let matrix=new DOMMatrix();
          for(let node=face;node?.nodeType===1;node=node.parentElement){const transform=getComputedStyle(node).transform;if(transform!=='none')matrix=new DOMMatrix(transform).multiply(matrix);}
          if(matrix.m33 < -0.001)return false;
        }
        return true;
      }).catch(()=>false);
      if(!facing)continue;
      try {await target.scrollIntoViewIfNeeded({timeout:3000});return true;} catch { /* Try another observed text match. */ }
    }
  }
  return false;
}

async function readControls(page, role, prefix, navigationOnly, mode = 'read') {
  const listed = [];
  const unavailable = [];
  const handles = new Map();
  const candidates = [];
  const counts = { c: 0, k: 0 };
  const viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
  for (const frame of await visibleFrames(page)) {
    const box = frame.parentFrame() ? await frame.frameElement().then(element => element.boundingBox()).catch(() => null) : {x:0,y:0};
    if (!box) continue;
    const locator = navigationOnly ? frame.locator('button, a, [role=button], [role=tab], summary, [onclick], [data-toggle], [data-bs-toggle], [aria-controls], input[type=button], input[type=submit], input[type=image], .dki-element-content.speech-bubble, img.dki-element-content.hasRollover, img.dki-element-content.dki-image-rollover[data-id]') : role === 'answer' ? frame.locator('input[type=radio]:not([role]),input[type=checkbox]:not([role]),[role=radio],[role=checkbox]') : frame.getByRole(role);
    const indices = await locator.evaluateAll((elements, view) => {
      const indices = [];
      for (let index = 0; index < elements.length; index += 1) {
        const el = elements[index];
        if (el.matches('[role=combobox],[role=option]')) continue;
        // Rise keeps earlier quiz cards mounted after advancing.
        const quizCard = el.closest('.quiz-card');
        if (quizCard && (!quizCard.classList.contains('quiz-card--active') || el.getAttribute('aria-disabled') === 'true')) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!el.getClientRects().length || !rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        if (el.matches('button.invisibutton')) {
          let hidden = false;
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const s = getComputedStyle(parent);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) { hidden = true; break; }
          }
          if (hidden || /wrong|incorrect|blocker/i.test(el.parentElement?.id || '')
            || rect.width * rect.height > innerWidth * innerHeight * 0.65) continue;
          const points = [[0.5,0.5],[0.25,0.25],[0.75,0.75]];
          if (!points.some(([x,y]) => {
            const hit = document.elementFromPoint(rect.x + rect.width*x, rect.y + rect.height*y);
            return hit && (hit === el || el.contains(hit));
          })) continue;
        }
        // Cornerstone uses this marker on passive layout/progress containers,
        // unlike actual collapse/tab controls. Preserve interactive evidence.
        if (el.getAttribute('data-toggle') === 'cso-frame' && !el.matches('a,button,input,summary,[role],[onclick],[tabindex]') && style.cursor !== 'pointer') continue;
        if (el.matches('.dki-element-content.speech-bubble, img.dki-element-content.hasRollover') && style.cursor !== 'pointer') continue;
        if (el.matches('img.dki-element-content.dki-image-rollover[data-id]')) {
          const dataId = el.getAttribute('data-id') || '';
          const base = /^\d+$/.test(dataId) ? el.ownerDocument.getElementById(`content_${dataId}`) : null;
          if (!base?.matches('img.dki-element-content.hasRollover') || el.id !== `${base.id}_rollover` || getComputedStyle(base).cursor !== 'pointer') continue;
        }
        let facing = true;
        for (let face = el; face?.nodeType === 1; face = face.parentElement) {
          if (getComputedStyle(face).backfaceVisibility !== 'hidden') continue;
          let matrix = new DOMMatrix();
          for (let node = face; node?.nodeType === 1; node = node.parentElement) {
            const transform = getComputedStyle(node).transform;
            if (transform !== 'none') matrix = new DOMMatrix(transform).multiply(matrix);
          }
          if (matrix.m33 < -0.001) { facing = false; break; }
        }
        if (!facing) continue;
        const inViewport = rect.bottom > Math.max(0,view.top) && rect.top < Math.min(innerHeight,view.bottom)
          && rect.right > Math.max(0,view.left) && rect.left < Math.min(innerWidth,view.right);
        const explicitRole = el.getAttribute('role')?.trim().split(/\s+/)[0];
        const checkbox = explicitRole ? explicitRole === 'checkbox' : el.matches('input[type=checkbox]');
        const outline = location.hostname === 'www.brainshark.com' && Boolean(el.closest('[id^="slide-list-slide-"]'));
        indices.push({index,inViewport,checkbox,outline});
      }
      return indices;
    }, {left:-box.x,top:-box.y,right:viewport.width-box.x,bottom:viewport.height-box.y}).catch(() => []);
    for (const candidate of indices) {
      const answerPrefix = candidate.checkbox ? 'k' : 'c';
      candidates.push({locator,...candidate, stableId:`${answerPrefix}${++counts[answerPrefix]}`});
    }
  }
  // Stable viewport-first order makes a scroll reveal later modules, while
  // keeping offscreen course controls as an auto-scroll fallback.
  candidates.sort((a,b) => Number(a.outline)-Number(b.outline) || Number(b.inViewport)-Number(a.inViewport));
  const allListed = [];
  for (const {locator,index,stableId,inViewport} of candidates.slice(0,400)) {
    const handle = locator.nth(index);
    if (!await handle.isVisible().catch(() => false) || !await handle.isEnabled().catch(() => false)) continue;
    const name = role === 'answer' ? await answerName(handle) : await controlName(handle);
    if (!name || (navigationOnly && !COURSE_PLAYER_LABEL.test(name) && (UNSAFE_LABEL.test(name) || COURSE_EXIT_LABEL.test(name)))) continue;
    if (navigationOnly && /^[<>]$/.test(name) && await handle.evaluate(storylineGraphic, true).catch(() => false)) continue;
    // Storyline exports decorative icon labels beside the real hotspots.
    if(navigationOnly&&inViewport&&/\boutline$/i.test(name)
      &&await handle.evaluate(el=>el.matches('.acc-shadow-el[data-represents]')).catch(()=>false)
      &&!await handle.evaluate(storylineGraphic).catch(()=>null))continue;
    let kind;
    if (navigationOnly) {
      const link = await handle.evaluate(el => {
        if (el.tagName !== 'A') return {safe:true,postback:false};
        const href = (el.getAttribute('href') || '').trim();
        if (/^javascript:\s*(?:void\s*\(\s*0\s*\)\s*;?|;)$/i.test(href.trim())) return {safe:true,postback:false};
        // Observed ASP.NET button postbacks: identifier target, empty string
        // arguments and fixed flags only. Never evaluate a model-supplied URL.
        if (el.getAttribute('role') === 'button') {
          const direct = /^javascript:\s*__doPostBack\(\s*(['"])([A-Za-z_][A-Za-z0-9_$:.]*)\1\s*,\s*(['"])\3\s*\)\s*;?$/.exec(href.trim());
          const options = /^javascript:\s*WebForm_DoPostBackWithOptions\(\s*new\s+WebForm_PostBackOptions\(\s*(['"])([A-Za-z_][A-Za-z0-9_$:.]*)\1\s*,\s*(['"])\3\s*,\s*true\s*,\s*(['"])\4\s*,\s*(['"])\5\s*,\s*false\s*,\s*true\s*\)\s*\)\s*;?$/.exec(href.trim());
          const target = (direct || options)?.[2];
          if (target && !/login|logout|signout|signin|password|account|payment|purchase|checkout|delete|remove|unsubscribe/i.test(target)) return {safe:true,postback:true};
        }
        return {safe:!['javascript:','mailto:','tel:','data:'].includes(el.protocol.toLowerCase()) && !/\b(logout|signout|delete|purchase|checkout|account|login)\b/i.test(href),postback:false};
      }).catch(() => ({safe:false,postback:false}));
      if (!link.safe) {
        if (/^(?:launch|start|continue)(?: course| module)?$/i.test(name) && unavailable.length < 8) unavailable.push(`${name}: link format is not supported safely; open it manually, then resume.`);
        continue;
      }
      const submits = await isSubmitControl(handle);
      // Form/postback navigation can consume assessment state; it is quiz-only
      // even when labelled Next rather than a final Submit control.
      kind = SUBMIT_LABEL.test(name) ? 'submission' : submits || link.postback || ASSESSMENT_START_LABEL.test(name) || /^(save|return later|summary)\b/i.test(name) ? 'quiz-navigation' : 'content';
      if (mode !== 'quiz' && (kind === 'submission' || kind === 'quiz-navigation')) continue;
    }
    const id = role === 'answer' ? stableId : `${prefix}${allListed.length + 1}`;
    handles.set(id, handle);
    const checked = await handle.evaluate(el => {
      const state = node => {
        if (node.matches('input[type=radio],input[type=checkbox]')) return node.checked;
        if (node.matches('[role=radio],[role=checkbox]')) {
          const value = node.getAttribute('aria-checked');
          if (value === 'true' || value === 'false') return value === 'true';
        }
      };
      const own = state(el);
      if (typeof own === 'boolean') return own;
      const nested = el.querySelectorAll('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]');
      return nested.length === 1 ? state(nested[0]) : undefined;
    }).catch(() => undefined);
    const answerMeta = role === 'answer' ? await handle.evaluate(el => {
      const group = el.closest('fieldset,[role=radiogroup],[role=group],.quiz-card');
      const scope = group || el.form || el.ownerDocument.body;
      const native = el.matches('input[type=radio],input[type=checkbox]');
      const owner = native ? el.form : group;
      return { kind: el.matches('input[type=checkbox],[role=checkbox]') ? 'checkbox' : 'radio',
        group: [location.href, performance.timeOrigin, native ? 'native' : 'aria',
          owner ? [...document.querySelectorAll('*')].indexOf(owner) : -1,
          el.getAttribute('name') || (native ? [...document.querySelectorAll('input')].indexOf(el) : '')],
        prompt: scope.innerText.replace(/(^|\n)(Time remaining[ \t]*(?:\n[ \t]*){0,2})\d{1,3}:\d{2}(?::\d{2})?(?=\n|$)/gi,'$1$2[countdown]'),
        document: performance.timeOrigin, value: el.getAttribute('value'), domId: el.id,
        control: [...document.querySelectorAll('input,[role=radio],[role=checkbox]')].indexOf(el) };
    }) : null;
    const groupId = answerMeta ? createHash('sha256').update(JSON.stringify(answerMeta.group)).digest('hex') : undefined;
    allListed.push({ id, name, ...(kind ? { kind } : {}), ...(typeof checked === 'boolean' ? {checked} : {}),
      ...(answerMeta ? {answerKind:answerMeta.kind,groupId} : {}) });
    if (answerMeta) Object.defineProperty(allListed.at(-1), 'answerIdentity', {value:answerMeta});
    if (navigationOnly && allListed.length >= 40) break;
  }
  listed.push(...allListed.slice(0,40));
  return { listed, handles, allListed, unavailable, complete:candidates.length<=400 };
}

async function answerPageIdentity(page) {
  const frames = [];
  for (const frame of await visibleFrames(page)) {
    const identity = await frame.evaluate(() => {
      const controls = [...document.querySelectorAll('input,textarea,select,button,a,[role=radio],[role=checkbox],[role=button],[role=radiogroup]')];
      if (controls.length > 1000 || (document.body?.innerText.length || 0) > 200_000) return null;
      return {url:location.href,document:performance.timeOrigin,
        text:(document.body?.innerText || '').replace(/(^|\n)(Time remaining[ \t]*(?:\n[ \t]*){0,2})\d{1,3}:\d{2}(?::\d{2})?(?=\n|$)/gi,'$1$2[countdown]'),
        forms:Array.from(document.forms,el=>[el.action,el.method,el.target]),
        controls:controls.map(el=>[el.tagName,el.id,...['type','name','role','value','href','onclick','formaction','formmethod','formtarget','aria-label','aria-labelledby','disabled'].map(attr=>
          attr==='value' && el.matches('textarea,input:not([type]),input[type=text]') ? null : el.getAttribute(attr))])};
    });
    if (!identity) return undefined;
    frames.push(identity);
  }
  return createHash('sha256').update(JSON.stringify([page.url(),frames])).digest('hex');
}

async function matchingDisplay(combo) {
  return combo.evaluate(el=>{
    const selected=(el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .filter(id=>/-control-value$/.test(id)).map(id=>el.ownerDocument.getElementById(id))
      .find(node=>node && node.getClientRects().length);
    if(selected) return selected.textContent.replace(/\s+/g,' ').trim().slice(0,160);
    const clone=el.cloneNode(true);
    clone.querySelectorAll('[role=listbox],[role=option],[hidden],[aria-hidden=true]').forEach(node=>node.remove());
    return clone.textContent.replace(/\s+/g,' ').trim().slice(0,160);
  });
}

async function matchingFieldName(combo,index) {
  return combo.evaluate((el,index)=>{
    const label=el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id=>el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    return label.trim().replace(/\s+/g,' ').slice(0,160) || `Matching field ${index+1}`;
  },index);
}

async function readSabaMatching(page, mode, hasQuestion) {
  const listed = [], handles = new Map();
  if (mode !== 'quiz' || !hasQuestion || !sabaAddress(page.url())) return {listed,handles};
  for (const frame of await visibleFrames(page)) {
    if (!sabaAddress(frame.url())) continue;
    const combos = frame.locator('div[role=combobox]').filter({visible:true});
    const count = Math.min(await combos.count(),12);
    for (let index=0; index<count; index++) {
      const combo=combos.nth(index);
      if (!await combo.isEnabled()) continue;
      const value=await matchingDisplay(combo);
      const label=await matchingFieldName(combo,index);
      const answered=Boolean(value) && !/^(?:select(?: an? (?:answer|option))?(?:\.{3}|…)?|choose(?: an? (?:answer|option))?)$/i.test(value);
      const id=`m${listed.length+1}`, name=label.slice(0,160);
      listed.push({id,name,kind:'quiz-navigation',selection:{value,answered}});
      handles.set(id,combo);
      matchingTargets.set(combo,{combo,option:false,name,frame,index});
    }
    const options=frame.locator('button[role=option]').filter({visible:true});
    if (!await options.count()) continue;
    const state=observationFor(page);
    let combo=null;
    // Saba variants without aria-expanded are bound to the exact dropdown
    // opened by our last observed click, never an arbitrary page menu.
    const expandedIndices=await combos.evaluateAll(nodes=>nodes.map((el,index)=>el.getAttribute('aria-expanded')==='true'?index:-1).filter(index=>index>=0));
    if(expandedIndices.length===1) combo=combos.nth(expandedIndices[0]);
    else if(expandedIndices.length===0 && state.matchingFrame===frame && state.matchingCombo && await state.matchingCombo.isVisible().catch(()=>false)) combo=state.matchingCombo;
    if(!combo)continue;
    for(let index=0;index<Math.min(await options.count(),20);index++) {
      const option=options.nth(index), name=await accessibleName(option);
      if(!name || !await option.isEnabled())continue;
      const linked=await option.evaluate((el,ids)=>{
        const list=el.closest('[role=listbox]');
        return !ids.length || Boolean(list?.id && ids.includes(list.id)) || ids.includes(el.id);
      },((await combo.getAttribute('aria-controls')) || (await combo.getAttribute('aria-owns')) || '').split(/\s+/).filter(Boolean));
      if(!linked)continue;
      const id=`m${listed.length+1}`;
      listed.push({id,name,kind:'quiz-navigation'});handles.set(id,option);
      matchingTargets.set(option,{combo,option:true,name,frame});
    }
  }
  return {listed,handles};
}

function observedQuestion(text, source, controls) {
  const matches=[...text.matchAll(/\bQuestion\s*:?\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/gi)];
  if(matches.length!==1)return undefined;
  const match=matches[0], number=Number(match[1]), total=Number(match[2]);
  if(number<1 || total<number || total>10000)return undefined;
  const names=new Set(controls.map(control=>control.name));
  const before=text.slice(0,match.index);
  const required=/Fields marked with an asterisk\s*\(\s*\*\s*\)\s*are required\s*/i.exec(before);
  const questionText=required ? before.slice(required.index+required[0].length) : text.slice(match.index+match[0].length);
  const stem=questionText.split('\n').map(line=>line.trim())
    .find(line=>line && !names.has(line) && !/^(?:next|back|previous|exit|select|time remaining|powered by)$/i.test(line))?.slice(0,1000) || '';
  return {id:createHash('sha256').update(`${source}\n${number}/${total}\n${stem}`).digest('hex'),number,total,stem};
}

async function readSnapshot(page, mode = 'read') {
  const sections = [];
  const resultViews = [];
  const navigationFrames = [];
  let hasStoryline = false;
  let storylineKey=null,storylineTimeline=null;
  let riseResultVisible = false;
  for (const frame of await visibleFrames(page)) {
    try {
      let exposed = true;
      for (let child = frame; child.parentFrame(); child = child.parentFrame()) {
        const element = await child.frameElement();
        exposed = await element.evaluate(el => {
          const r = el.getBoundingClientRect();
          if (!(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return false;
          for (let face = el; face?.nodeType === 1; face = face.parentElement) {
            const style = getComputedStyle(face);
            if (Number(style.opacity) === 0) return false;
            if (style.backfaceVisibility !== 'hidden') continue;
            let matrix = new DOMMatrix();
            for (let node = face; node?.nodeType === 1; node = node.parentElement) {
              const transform = getComputedStyle(node).transform;
              if (transform !== 'none') matrix = new DOMMatrix(transform).multiply(matrix);
            }
            if (matrix.m33 < -0.001) return false;
          }
          return true;
        });
        if (!exposed) break;
      }
      if (!exposed) continue;
      const observed = await frame.evaluate(() => {
        const visible = (el, inViewport = true) => {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          if (!r.width || !r.height || s.display === 'none' || s.visibility === 'hidden' || !el.getClientRects().length) return false;
          if (inViewport && !(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return false;
          for (let face = el; face?.nodeType === 1; face = face.parentElement) {
            if (Number(getComputedStyle(face).opacity) === 0) return false;
            if (getComputedStyle(face).backfaceVisibility !== 'hidden') continue;
            let matrix = new DOMMatrix();
            for (let node = face; node?.nodeType === 1; node = node.parentElement) {
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
          if (location.hostname === 'www.brainshark.com' && parent.closest('[id^="slide-list-slide-"]')) continue;
          const quizCard = parent.closest('.quiz-card');
          if (quizCard && !quizCard.classList.contains('quiz-card--active')) continue;
          const value = node.textContent.replace(/\s+/g, ' ').trim();
          if (value) lines.push(value);
        }
        const headings = Array.from(document.querySelectorAll('h1,h2,[role=heading]'));
        const heading = headings.find(el => visible(el)) || headings.find(el => visible(el, false));
        const slideLabel = document.getElementById('slide-label')?.textContent.trim();
        const riseHeading = [...document.querySelectorAll('.quiz h1, .quiz h2, .quiz h3, .quiz [role=heading], .quiz-results__title')]
          .find(el => el.textContent.trim() === 'Quiz Results' && el.closest('.quiz') && visible(el));
        let riseResult = '';
        for (let el = riseHeading?.parentElement; el && !el.matches('.quiz'); el = el.parentElement) {
          const text = el.innerText;
          if (/\bQuestion\s+\d+\s+of\s+\d+\b/i.test(text)) break;
          if (/\bYour score\s*:?\s*\d+(?:\.\d+)?\s*%/i.test(text) && /(?:^|\n)\s*(?:Passed|Failed)\s*(?:\n|$)/i.test(text)) {
            riseResult = text.replace(/^Passing\s+(?=\d+(?:\.\d+)?\s*%)/im, 'Passing Score ');
            break;
          }
        }
        const scrollArea = document.querySelector('a.nav-sidebar__outline-item__link') ? document.querySelector('.page-wrap') : null;
        const position = scrollArea ? scrollArea.scrollTop : scrollY;
        const end = scrollArea ? position + scrollArea.clientHeight >= scrollArea.scrollHeight - 2 : position + innerHeight >= document.documentElement.scrollHeight - 2;
        const layer = document.querySelector('.slide-layer.base-layer.shown');
        const playbackModels = new Set([...document.querySelectorAll('button.acc-shadow-el[data-represents]')]
          .filter(el => !layer?.contains(el) && /^(?:play|pause|replay|mute|unmute)(?:\s*\([^)]*\))?$/i.test(
            (el.getAttribute('aria-label') || el.textContent || '').trim()))
          .map(el => el.getAttribute('data-represents')));
        // Storyline's accessibility text and current layer describe the whole
        // slide even while its visible SVG text animates in and out.
        const storyline = slideLabel && layer ? {
          slide: slideLabel, layer: layer.getAttribute('data-model-id') || layer.id,
          content: layer.textContent.replace(/\s+/g, ' ').trim(),
          accessible: [...document.querySelectorAll('.acc-text[data-represents]')]
            .filter(el => layer.contains(el) || !playbackModels.has(el.getAttribute('data-represents'))).map(el =>
            [el.getAttribute('data-represents'), el.textContent.replace(/\s+/g, ' ').trim()]),
          dialogs: [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].map(el => el.innerText),
        } : null;
        const audio=[...document.querySelectorAll('audio,video')].find(a=>!a.paused&&Number.isFinite(a.duration)&&a.duration>1&&a.currentTime<a.duration-.2);
        return { heading: heading?.textContent?.trim() || document.title, text: lines.join('\n'), riseResult, position: Math.round(position), end,
          timeline:storyline&&audio?{remaining:(audio.duration-audio.currentTime)/Math.max(.1,audio.playbackRate)}:null,
          storyline,
          storylineResult: /^slide:\s*Results Slide$/i.test(slideLabel || '') && Boolean(document.querySelector('.slide-layer.base-layer.shown')) };
      });
      if (!observed.text.trim()) continue;
      riseResultVisible ||= Boolean(observed.riseResult);
      resultViews.push(observed.riseResult || (observed.storylineResult ? `Quiz Results\n${observed.text}` : observed.text));
      const source = canonicalCourseSource(await frame.evaluate(() => location.href).catch(() => frame.url()));
      hasStoryline ||= Boolean(observed.storyline);
      if(observed.storyline){storylineKey=`${source}:${observed.storyline.layer}`;storylineTimeline=observed.timeline;}
      navigationFrames.push({ source, heading: observed.heading, content: observed.storyline || observed.text, position: observed.position });
      sections.push(`[Source: ${source} | ${observed.heading || ''} | scroll ${observed.position}${observed.end ? ' | end of page' : ''}]\n${observed.text}`);
    } catch {
      // A cross-origin frame has no readable body.
    }
  }
  const buttons = await readControls(page, 'button', 'b', true, mode);
  if (buttons.unavailable.length) console.log(`LEARNER_PROGRESS ${JSON.stringify({message:buttons.unavailable.join(' ')})}`);
  const matching=await readSabaMatching(page,mode,Boolean(observedQuestion(resultViews.join('\n'),canonicalCourseSource(page.url()),[])));
  buttons.listed=[...matching.listed,...buttons.listed].slice(0,40);
  buttons.handles=new Map([...buttons.handles,...matching.handles]);
  const answers = riseResultVisible ? { listed: [], handles: new Map() } : await readControls(page, 'answer', '', false);
  const handles = new Map([...buttons.handles, ...answers.handles]);
  const fields = [];
  for (const frame of await visibleFrames(page)) {
    const courseFrame = await frame.evaluate(() => location.hostname === 'www.brainshark.com'
      || (location.origin === 'https://canon-europe.csod.com' && !/login|signin|oauth|sso/i.test(location.pathname)
        && Boolean(document.querySelector('fieldset input[type=radio],fieldset input[type=checkbox],[role=radiogroup]'))
        && !document.querySelector('input[type=password],form[action*=login i],form[action*=signin i]'))).catch(() => false);
    if (!courseFrame || mode !== 'quiz') continue;
    const inputs = frame.locator('input:not([type]),input[type=text],textarea').filter({visible:true});
    for (let index=0; index<Math.min(await inputs.count(), 8); index++) {
      const handle = inputs.nth(index);
      if (!await handle.isEditable()) continue;
      const name = await controlName(handle) || await handle.getAttribute('placeholder');
      if (!name || /password|secret|email|login|username|token/i.test(name)) continue;
      const id = `f${fields.length+1}`;
      const identity = await handle.evaluate(el => ({source:location.href,document:performance.timeOrigin,
        prompt:(el.closest('fieldset,[role=group],.question') || el.ownerDocument.body).innerText,domId:el.id}));
      fields.push({id,name:name.slice(0,160),value:(await handle.inputValue()).slice(0,2000)});
      Object.defineProperty(fields[fields.length-1], 'answerIdentity', {value:identity});
      handles.set(id,handle);
    }
  }
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
  const outlines=await readCourseOutlines(page);
  const state=observationFor(page);
  const question=observedQuestion(resultViews.join('\n'),canonicalCourseSource(page.url()),[...buttons.listed,...answers.listed]);
  if(state.questionId!==question?.id) {
    for(const key of ['feedback','blockedControl','screenshotBlocked','lastBlockedControl','image','imageUrl','imageIdentity','captureView','matchingCombo','matchingFrame'])delete state[key];
    state.questionId=question?.id;
  }
  const image=state.imageUrl===page.url()?state.image:undefined;
  const imageIdentity=image?state.imageIdentity:undefined;
  delete state.image;delete state.imageUrl;
  const snapshot = {
      title: (await page.title().catch(() => '')).slice(0,200),
      url: page.url().slice(0,500),
      text: `${await observePlayerEvidence(page)}\n${buttons.unavailable.length?`Unavailable course controls: ${buttons.unavailable.join(' ')}\n`:''}${state.feedback?`Tool feedback: ${state.feedback}\n`:''}${sections.map(section => section.slice(0, Math.floor(7400 / Math.max(1, sections.length)))).join('\n')}`.slice(0, 8000),
      buttons: buttons.listed,
      choices: answers.listed,
      ...(answers.listed.length || fields.length ? {answerPageId:answers.complete === false ? undefined : await answerPageIdentity(page)} : {}),
      ...(fields.length ? {fields} : {}),
      tabs,
      ...(image?{image}:{}),
      ...(question?{question}:{}),
      ...(imageIdentity?{imageIdentity}:{}),
      ...(outlines.length?{outlines}:{}),
      ...(state.blockedControl ? { blockedControl: true } : {}),
      ...(state.screenshotBlocked ? { screenshotBlocked: true } : {}),
  };
  // Raw live text is local verification evidence, not additional provider
  // context. Exclude it from JSON and never populate it from course memory.
  Object.defineProperty(snapshot, 'resultViews', {value: resultViews});
  Object.defineProperty(snapshot,'storylineKey',{value:storylineKey});
  Object.defineProperty(snapshot,'storylineTimeline',{value:storylineTimeline});
  const visited=storylineKey&&observationFor(page).visitedPanels?.get(storylineKey);
  if(visited?.size)snapshot.text+=`\nTool feedback: Panels already opened on this exact slide: ${[...visited].join(', ')}. Prefer remaining required panels, then an enabled Next; a different slide can reuse the same heading.`;
  Object.defineProperty(snapshot, 'answerControls', {value:[...(answers.allListed || answers.listed),...fields]});
  if (hasStoryline) {
    const targets = {};
    for (const button of buttons.listed) {
      if (!/^(?:next|prev(?:ious)?|back|continue)(?: page| slide)?[ »›→]*$/i.test(button.name)) continue;
      const handle = buttons.handles.get(button.id);
      const identity = await handle?.evaluate(el => document.getElementById('slide-label')
        && el.matches('.acc-shadow-el[data-represents]') ? [location.href, el.getAttribute('data-represents')] : null);
      if (identity) targets[button.id] = { identity, name: button.name, kind: button.kind };
    }
    Object.defineProperty(snapshot, 'navigationView', { value: { frames: navigationFrames, targets } });
  }
  return {snapshot, handles};
}

function revalidateLearnerDecision(before, after, action) {
  if (action?.action === 'answer-group') {
    const controls = snapshot => snapshot.answerControls && [...snapshot.answerControls].sort((a,b)=>a.id.localeCompare(b.id));
    const originalControls = controls(before), currentControls = controls(after);
    const stable = before.answerPageId && before.answerPageId === after.answerPageId
      && originalControls && currentControls && JSON.stringify(originalControls) === JSON.stringify(currentControls);
    return stable ? {ok:true,action,snapshot:before} : {ok:false};
  }
  const original = before?.navigationView, current = after?.navigationView;
  const target = original?.targets[action?.targetId];
  let remapped = action;
  if (action?.action === 'click' && target) {
    if (!current || JSON.stringify(original.frames) !== JSON.stringify(current.frames)) return { ok: false };
    const matches = Object.entries(current.targets).filter(([, value]) => JSON.stringify(value) === JSON.stringify(target));
    if (matches.length !== 1) return { ok: false };
    remapped = { ...action, targetId: matches[0][0] };
  }
  if (sameLearnerView(before, after)) return { ok: true, action: remapped };
  if (action?.action !== 'click' || !original || !current || before.question || after.question
    || before.choices?.length || after.choices?.length || before.fields?.length || after.fields?.length
    || [before, after].some(snapshot => snapshot.buttons?.some(control => control.selection || control.kind === 'quiz-navigation' || control.kind === 'submission'))
    || !original.targets[action.targetId]) return { ok: false };
  const stable = snapshot => {
    const { text, buttons, image, imageIdentity, ...rest } = snapshot;
    return { ...rest, frames: snapshot.navigationView.frames };
  };
  if (JSON.stringify(stable(before)) !== JSON.stringify(stable(after))) return { ok: false };
  return { ok: true, action: remapped };
}

function sameLearnerView(before, after) {
  const comparable = value => {
    if (!value || typeof value !== 'object') return value;
    const { image, imageIdentity, coordinationStart, unchangedAction, playback, sourceMaterials, sourceExtraction, sourcePublication, ...view } = value;
    if (playback) {
      view.playback = { identity: playback.identity, slide: playback.slide, completed: playback.completed, question: playback.question };
      if (typeof view.text === 'string') view.text = view.text.replace(/^(?:\d{1,2}:\d{2}(?::\d{2})?|\/)$/gm, '[playback time]');
    }
    // Canon renders this labelled countdown as its own text line. Answers,
    // question text, expiry notices and every other page change stay significant.
    if (typeof view.text === 'string') view.text = view.text.replace(/(^|\n)(Time remaining[ \t]*\n)\d{1,3}:\d{2}(?::\d{2})?(?=\n|$)/gi, '$1$2[countdown]');
    return view;
  };
  return JSON.stringify(comparable(before)) === JSON.stringify(comparable(after));
}

function storylineTimelineWait(snapshot){
  if(!snapshot.storylineKey||snapshot.question||snapshot.choices?.length||snapshot.sourceMaterials?.length)return 0;
  const remaining=snapshot.storylineTimeline?.remaining;
  if(!Number.isFinite(remaining)||remaining<=.2||remaining>120)return 0;
  const player=/^(?:play|pause|replay|previous|prev|menu|settings|sidebar toggle|back to top|playback speed|enter full-screen mode|mute(?:\s*\([^)]*\))?|unmute|show captions(?:\s*\([^)]*\))?)$/i;
  if(snapshot.buttons?.some(button=>!player.test(button.name)))return 0;
  return Math.min(2000,Math.ceil(remaining*1000));
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
    }, 120_000);
    pending.push(entry);
    process.stdout.write(`LEARNER_SNAPSHOT ${JSON.stringify(snapshot)}\n`);
    }),
    close: () => rl.close(),
  };
}

async function applyAction(page, action, snapshot, handles, mode = 'read') {
  if (!localActionAllowed(action, snapshot, mode)) throw new Error('Learner action is not allowed');
  if(action.action==='answer-group'&&action.answers.length===1){
    const only=action.answers[0],choice=snapshot.choices?.find(c=>c.id===only.targetId);
    if(only.checked===true&&choice?.answerKind==='radio'){
      if((await readSnapshot(page,mode)).snapshot.answerPageId!==action.pageId)throw new GroupedAnswerChanged('Single answer page changed');
      return applyAction(page,{action:'answer-select',targetId:only.targetId},snapshot,handles,mode);
    }
  }
  if (action.action === 'answer-group') return applyAnswerGroup(page, action, snapshot, mode);
  if(snapshot.question && (await readSnapshot(page,mode)).snapshot.question?.id!==snapshot.question.id)throw new Error('Learner question target changed');
  const state=observationFor(page);delete state.feedback;delete state.blockedControl;delete state.screenshotBlocked;
  if (action.action === 'select-tab') {
    const target = handles.get(action.targetId);
    const observed = snapshot.tabs?.find(tab => tab.id === action.targetId);
    if (!target?.page || target.page.isClosed() || target.page.url() !== target.url || target.url !== observed?.url || await target.page.title() !== target.name) throw new Error('Learner tab changed');
    if (new URL(page.url()).origin !== new URL(target.url).origin) throw new Error('Learner tab website changed');
    await target.page.bringToFront();
    return target.page;
  }

  async function applyAnswerGroup(page, action, snapshot, mode) {
    const fresh = await readSnapshot(page, mode);
    if (!validAnswerGroup(action, snapshot, mode) || fresh.snapshot.answerPageId !== action.pageId) throw new GroupedAnswerChanged('Grouped answer page changed before preflight');
    const expected = new Map();
    for (const answer of action.answers) {
      const handle = fresh.handles.get(answer.targetId);
      const target = fresh.snapshot.answerControls.find(control => control.id === answer.targetId);
      const original = snapshot.answerControls.find(control => control.id === answer.targetId);
      if (!handle || !target || target.name !== original?.name || JSON.stringify(target.answerIdentity)!==JSON.stringify(original.answerIdentity)
        || !await handle.isVisible() || !await handle.isEnabled()) throw new GroupedAnswerChanged('Grouped answer target changed or unavailable');
      if ('text' in answer && !await handle.isEditable()) throw new GroupedAnswerChanged('Grouped response is not editable');
      if ('checked' in answer && await handle.evaluate(el => el.matches('input[type=radio],input[type=checkbox]'))) {
        await handle.setChecked(answer.checked, {trial:true,timeout:2500});
      } else await handle.click({trial:true,timeout:2500});
      expected.set(answer.targetId, {handle, target});
    }
    for (const answer of action.answers) {
      const current = await readSnapshot(page, mode);
      if (current.snapshot.answerPageId !== action.pageId) throw new GroupedAnswerChanged('Grouped answers stopped: navigation, question or options changed; inspect current state');
      const {handle, target} = expected.get(answer.targetId);
      const now = current.snapshot.answerControls.find(control => control.id === answer.targetId);
      if (!now || now.name !== target.name || now.groupId !== target.groupId || !await handle.isVisible() || !await handle.isEnabled()) throw new GroupedAnswerChanged('Grouped answers stopped: target changed');
      if ('text' in answer) {
        await handle.fill(answer.text, {timeout:5000});
        if (await handle.inputValue() !== answer.text) throw new GroupedAnswerChanged('Grouped written response was not confirmed');
      } else {
        const native = await handle.evaluate(el => el.matches('input[type=radio],input[type=checkbox]'));
        if (native) await handle.setChecked(answer.checked, {timeout:5000});
        else if (now.checked !== answer.checked) {
          const riseControl = await handle.evaluate(el => Boolean(el.closest('.quiz-card--active')));
          const point = await handle.evaluate(storylineGraphic);
          if (riseControl) await handle.press('Space', {timeout:5000});
          else if (point) await clickStorylineControl(page,handle,point,true);
          else await handle.click({timeout:5000});
        }
        const checked = await handle.evaluate(el => el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true');
        if (checked !== answer.checked) throw new GroupedAnswerChanged('Grouped answer selection was not confirmed');
      }
    }
    const post = await readSnapshot(page, mode);
    if (post.snapshot.answerPageId !== action.pageId) throw new GroupedAnswerChanged('Grouped answers stopped: page changed after selection');
    for (const answer of action.answers) {
      const target = post.snapshot.answerControls.find(control => control.id === answer.targetId);
      if (!target || ('text' in answer ? target.value !== answer.text : target.checked !== answer.checked)) throw new GroupedAnswerChanged('Grouped answer post-state mismatch');
    }
    observationFor(page).feedback = `Set and verified ${action.answers.length} answers on the current page. No navigation or submission was performed.`;
  }
  if (action.action === 'scroll') {
    // Scroll each visible course frame as well as the outer wrapper.
    for (const frame of await visibleFrames(page)) await frame.evaluate(direction => {
      const scrollArea = document.querySelector('a.nav-sidebar__outline-item__link') ? document.querySelector('.page-wrap') : null;
      const distance = (direction === 'up' ? -1 : 1) * Math.max(300, (scrollArea?.clientHeight || innerHeight) * 0.8);
      (scrollArea || window).scrollBy(0, distance);
    }, action.direction || 'down').catch(() => undefined);
    await page.waitForTimeout(100);
    return;
  }
  if(action.action==='find-text') {
    const found=await findRenderedText(page,action.text.trim());
    state.feedback=found?`Found rendered text: ${action.text.trim()}`:`Text was not found in rendered course content: ${action.text.trim()}`;
    return;
  }
  if (action.action === 'answer-text') {
    const field = handles.get(action.targetId);
    const observed = snapshot.fields?.find(item => item.id === action.targetId);
    if (!field || !observed || !await field.isVisible() || !await field.isEditable()
      || (await controlName(field) || await field.getAttribute('placeholder')) !== observed.name) throw new CourseControlBlocked('The response field changed');
    await field.fill(action.text, {timeout:5000});
    if (await field.inputValue() !== action.text) throw new CourseControlBlocked('The written response could not be confirmed');
    state.feedback='Entered a written answer. Inspect the enabled Submit control to send it.';
    return;
  }
  if (action.action === 'wait') {
    const ms = Math.max(0, Math.min(1000, Number(action.ms) || 500));
    await page.waitForTimeout(ms);
    return;
  }
  if (action.action === 'capture') {
    const {image, blockedControl, screenshotBlocked, coordinationStart, ...view} = snapshot;
    view.text = view.text?.replace(/^Tool feedback: [^\n]*\n/gm, '');
    if (sameLearnerView(state.captureView, view)) {
      state.feedback = 'Screenshot skipped because the visible course page is unchanged. Use the observed controls or ask for guidance.';
      state.screenshotBlocked = true;
      return;
    }
    state.captureView = view;
    await captureCurrentView(page);
    return;
  }
  const handle = handles.get(action.targetId);
  if (!handle) throw new Error('Learner target is not on the page');
  const target = [...(snapshot.buttons || []), ...(snapshot.choices || [])].find(item => item.id === action.targetId);
  const matching=matchingTargets.get(handle);
  if(matching) {
    const name=matching.option?await accessibleName(handle):await matchingFieldName(handle,matching.index);
    if(mode!=='quiz' || action.action!=='click' || !sabaAddress(page.url()) || !await handle.isVisible() || !await handle.isEnabled()
      || name!==target?.name)throw new CourseControlBlocked('The matching control changed');
    if(matching.option) {
      await handle.click({timeout:5000});
      const deadline=Date.now()+3000;
      let selected=await matchingDisplay(matching.combo);
      while(selected!==matching.name && Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,100));
        selected=await matchingDisplay(matching.combo);
      }
      if(selected!==matching.name)throw new CourseControlBlocked('The matching selection could not be confirmed');
      delete state.matchingCombo;
      delete state.matchingFrame;
    } else {
      await handle.click({timeout:5000});
      state.matchingCombo=handle;
      state.matchingFrame=matching.frame;
    }
    return;
  }
  if (!await handle.isVisible() || !await handle.isEnabled() || (await (action.action === 'answer-select' ? answerName(handle) : controlName(handle))) !== target?.name) throw new Error('Learner target changed');
  const point = await handle.evaluate(storylineGraphic);
  if (point) {
    await clickStorylineControl(page, handle, point, action.action === 'answer-select');
    if(action.action==='click'&&snapshot.storylineKey&&/hotspot|outline|panel/i.test(target.name)){
      state.visitedPanels??=new Map();if(!state.visitedPanels.has(snapshot.storylineKey))state.visitedPanels.set(snapshot.storylineKey,new Set());
      state.visitedPanels.get(snapshot.storylineKey).add(target.name);
    }
    return;
  }

  const riseControl = await handle.evaluate(el => Boolean(el.closest('.quiz-card--active')));
  if (riseControl && action.action === 'answer-select' && ['radio', 'checkbox'].includes(await handle.getAttribute('role'))) {
    if (await handle.getAttribute('aria-checked') !== 'true') await handle.press('Space', { timeout: 5000 });
    if (await handle.getAttribute('aria-checked') !== 'true') throw new CourseControlBlocked('Rise answer selection could not be confirmed');
    return;
  }
  if (action.action === 'click') {
    await protectSabaPopups(page);
    if (riseControl && /^(submit|next)$/i.test(target.name)) {
      await handle.press('Enter', { timeout: 5000 });
    } else if (await handle.evaluate(dkiInformationIcon).catch(() => null)) {
      if (!await handle.isVisible() || !await handle.isEnabled()) throw new Error('Learner target changed');
      // Pointer movement creates a covering rollover image on these DKI icons.
      // Activate the validated visible representative without triggering hover.
      await handle.dispatchEvent('click');
    } else await handle.click({ timeout: 5000 });
    return;
  }
  const brainshark = await handle.evaluate(el => location.hostname === 'www.brainshark.com' && el.matches('input[type=radio],input[type=checkbox]'));
  if (brainshark) {
    if (!await handle.isChecked()) await handle.press('Space', {timeout:5000});
    if (!await handle.isChecked()) throw new CourseControlBlocked('The answer selection could not be confirmed');
  } else if(await handle.evaluate(el=>/^(?:hpi-external|content-na2prd0004-na2hp)\.sabacloud\.com$/.test(location.hostname) && el.matches('input[type=radio],input[type=checkbox]'))) {
    await selectNativeSabaAnswer(handle);
  } else await handle.check({ timeout: 5000 });
}

async function activateCourseExit(page, handle, name) {
  if (!COURSE_EXIT_LABEL.test(name) || !await handle.isVisible() || !await handle.isEnabled()
    || await controlName(handle) !== name) throw new CourseControlBlocked('The course exit changed');
  const point = await handle.evaluate(storylineGraphic);
  if (point) await clickStorylineControl(page, handle, point, false);
  else await handle.click({ timeout: 5000 });
}

async function selectNativeSabaAnswer(handle) {
  if(await handle.isChecked())return;
  try {await handle.check({timeout:1200});}
  catch(error) {
    if(error?.name!=='TimeoutError' && !/did not change its state/i.test(error?.message||''))throw error;
  }
  if(await handle.isChecked())return;
  const input=await handle.elementHandle();
  if(!input)throw new CourseControlBlocked('The native answer changed');
  try {
    const labels=handle.locator('xpath=ancestor::label | //label').filter({visible:true});
    for(let index=0;index<Math.min(await labels.count(),40);index++) {
      const label=labels.nth(index);
      if(!await label.evaluate((el,input)=>Array.from(input.labels || []).includes(el),input))continue;
      try {await label.click({timeout:1200});}
      catch(error) {if(error?.name!=='TimeoutError')throw error;}
      if(await handle.isChecked())return;
    }
  } finally {await input.dispose();}
  await handle.focus({timeout:1500});
  await handle.press('Space',{timeout:1500});
  if(!await handle.isChecked())throw new CourseControlBlocked('The native answer selection could not be confirmed');
}
async function emitQuestion(payload, page, browser, courseResult, quizResult) {
  const tabs = await listBrowserTabs(browser);
  console.log(`LEARNER_TABS ${JSON.stringify(tabs)}`);
  console.log(learnerQuestionLine({ ...payload, url: page.url(), cdpTargetId:await browserTargetId(page) }));
  finish(false, LEARNER_NEEDS_INPUT, quizResult, courseResult);
}

function finish(completed, reason, result, courseResult) {
  const payload = result ? quizResultPayload(result) : completed
    ? { completed: 1, total: 1 }
    : { completed: 0, total: 1, failures: [{ title: 'quiz-learn', reason: reason || 'learner-stopped' }] };
  console.log(`AUTOMATION_RESULT ${JSON.stringify({ ...payload, ...(!completed ? { completed: 0,
    ...(!payload.failures ? { failures: [{ title: 'quiz-learn', reason: reason || 'course-completion-unverified' }] } : {}) } : {}),
    ...(courseResult ? { courseResult } : {}) })}`);
  if (!completed) process.exitCode = 1;
}

async function main() {
  const options = parseLearnQuizArgs(process.argv);
  const mode = process.env.VITRIOL_LEARNER_MODE === 'quiz' ? 'quiz' : 'read';
  const coordinated = mode === 'quiz' && process.env.VITRIOL_COORDINATE === '1';
  const browser = await chromium.connectOverCDP(CDP_URL);
  let reader = null;
  let landing = null;
  let brainsharkCompleted = false;
  try {
    const pages=browser.contexts().flatMap(context=>context.pages());
    const selectedAddress=process.env.VITRIOL_CAPTURE_TARGET;
    const matching=selectedAddress ? pages.filter(tab=>tab.url()===selectedAddress) : [];
    let page = process.env.VITRIOL_CDP_TARGET_ID ? await selectBrowserPage(pages,options.tabIdx)
      : selectedAddress ? matching.length===1 ? matching[0] : null : pages[options.tabIdx];
    if (!page) throw new Error('Tab index is not open');
    if (options.dryRun) {
      const { snapshot } = await readSnapshot(page, mode);
      console.log(`Dry run: quiz-learn observed "${snapshot.title || 'untitled'}"`);
      return;
    }
    if(certificationAddress(page.url())){
      const outcome=await runCertificationLearning(page,mode);
      console.log(`AUTOMATION_RESULT ${JSON.stringify(outcome)}`);
      if(!outcome.total||outcome.completed!==outcome.total)process.exitCode=1;
      return;
    }
    const selected = page;
    const startedAtCourse=/\/learningeventdetail[;/]/i.test(selected.url());
    page = await launchSelectedCourse(page);
    landing = startedAtCourse ? selected : originatingSabaPage(page);
    const storylinePage = page;
    const finalizeStoryline = createStorylineFinalizer(storylinePage, activateCourseExit);
    async function finalizeCurrentStoryline() {
      if (page !== storylinePage) return false;
      const finalization = await finalizeStoryline();
      if (!finalization.attempted) return false;
      const courseResult = { status: finalization.verified ? 'completed' : 'unverified', title: finalization.title,
        evidence: finalization.evidence || [], ...(finalization.reason ? { reason: finalization.reason } : {}) };
      const quizResult = mode === 'quiz' ? finalization.quizResult : undefined;
      if (finalization.verified) {
        finish(quizResult?.status !== 'failed', undefined, quizResult, courseResult);
      } else {
        await emitQuestion({
          question: `The module reached its end, but course completion is not verified (${finalization.reason}). Check the learning portal result without retaking.`,
          options: ['Check the course result'],
        }, page, browser, courseResult, quizResult);
      }
      return true;
    }
    if (/remote_frameset_modern\.html/i.test(page.url())) {
      for(let attempt=0; attempt<15; attempt++) {
        if (await readBrainshark(page)) break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    reader = createActionReader();
    let repeatState = null;
    let lastPlayback = null;
    let idlePlaybackSince = Date.now();
    let playbackAnnouncementAt = 0;
    let playbackStartedAt = Date.now();
    let playbackStalledSince = Date.now();
    async function verifyCourse(quizResult) {
      const verified = await finishSabaCourse(landing, brainsharkCompleted || quizResult?.status==='passed', page,Boolean(quizResult));
      if (!verified) return false;
      const tabs = await listBrowserTabs(browser);
      console.log(`LEARNER_TABS ${JSON.stringify(tabs)}`);
      console.log(`AUTOMATION_RESULT ${JSON.stringify({completed:1,total:1,...(quizResult?{quizResult}:{}),courseResult:{status:'completed',title:verified.title,evidence:verified.evidence}})}`);
      return true;
    }
    async function terminalResult(result) {
      if(result.status==='passed' && landing) {
        if(await verifyCourse(result))return;
        await emitQuestion({question:'The assessment passed, but the same Saba course is not yet verified Successful. Check its normal Exit or Close Player, then resume without retaking.',options:['Check the course result']},page.isClosed()?landing:page,browser);
        return;
      }
      finish(result.status==='passed',undefined,result);
    }
    if(landing===page && await currentCourseSuccessful(landing) && await verifyCourse())return;
    let coordinatedStalls=0;
    const collectedPublications = new Set();
    const timelineWaits=new Map();
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      if (page.isClosed()) {
        if (await verifyCourse()) return;
        if (landing && !landing.isClosed()) {page=landing;continue;}
        throw Error('The course player closed before its result could be verified');
      }
      if (await finalizeCurrentStoryline()) return;
      const playback = await readBrainshark(page);
      if (playback?.completed) {
        brainsharkCompleted = true;
        if (!landing) landing = originatingSabaPage(page);
        if (await verifyCourse()) return;
        await emitQuestion({question:'The course player shows Completed. Can you confirm its result in the learning portal?',options:['Check the course result']},page,browser);
        return;
      }
      if (playback) {
        const question = listeningQuestion(playback);
        const approved = playbackApproved(process.env.VITRIOL_LEARNER_CONVERSATION, playback, process.env.VITRIOL_LEARNER_GUIDANCE);
        if (question && !approved) {
          await playbackControl(page,'pause');
          await emitQuestion(question,page,browser);
          return;
        }
        await setPlaybackSpeed(page,2);
        if (Date.now()-playbackStartedAt>20*60*1000) {
          await playbackControl(page,'pause');
          await emitQuestion({question:CONTINUE_LISTENING_QUESTION,options:['Continue with playback','Stop for now']},page,browser);
          return;
        }
        if (!lastPlayback || lastPlayback.slide!==playback.slide || Math.abs(lastPlayback.elapsedMs-playback.elapsedMs)>300) {
          idlePlaybackSince=Date.now();
          playbackStalledSince=Date.now();
        }
        if (Date.now()-playbackStalledSince>45000) {
          await emitQuestion({question:'The course playback has stopped advancing. Can you check for a loading error or a prompt in the course browser?',options:['Done, resume now']},page,browser);
          return;
        }
        lastPlayback=playback;
        if (playback.playing || !playback.question || playback.answered && !playback.submitVisible) {
          if (!playback.playing && Date.now()-idlePlaybackSince>3500) {
            if (playback.durationMs>0 && playback.elapsedMs>=playback.durationMs-500) {
              if (playback.slide===playback.totalSlides) {
                // Revisit content for actual listening credit. Seeking and
                // outline navigation alone never establish completion.
                await playbackControl(page,'restart');
              } else await playbackControl(page,'next');
            } else await playbackControl(page,'play');
            idlePlaybackSince=Date.now();
          }
          if (Date.now()-playbackAnnouncementAt>15000) {
            const requirement=playback.requirements;
            const credit=requirement?.audioPercent;
            console.log(`LEARNER_PROGRESS ${JSON.stringify({message:`Playing slide ${playback.slide} of ${playback.totalSlides}${credit!=null?` · listening ${credit.toFixed(1)}% of ${requirement.requiredAudio}% required`:''}.`})}`);
            playbackAnnouncementAt=Date.now();
          }
          await new Promise(resolve=>setTimeout(resolve,1500));
          step-=1;
          continue;
        }
      }
      let { snapshot, handles } = await readSnapshot(page, mode);
      if ((mode === 'read' || process.env.VITRIOL_LEARNER_INTENT) && !snapshot.choices.length) {
        for (const frame of await visibleFrames(page)) {
          const root = publicationRoot(frame.url()) || storylineRoot(frame.url());
          if (!root || collectedPublications.has(root)) continue;
          console.log(`LEARNER_PROGRESS ${JSON.stringify({message:'Collecting referenced lesson text within this publication; images and missing sources remain explicit gaps.'})}`);
          const material = storylineRoot(frame.url()) ? await collectStorylineMaterial(frame,{title:snapshot.title}) : await collectAuthoredMaterial(frame, {title:snapshot.title});
          if (!material) continue;
          collectedPublications.add(root);
          snapshot.sourceMaterials = material.materials;
          snapshot.sourcePublication = frame.url().split(/[?#]/)[0];
          snapshot.sourceExtraction = JSON.stringify({...material,materials:undefined}).slice(0,4000);
          console.log(`LEARNER_PROGRESS ${JSON.stringify({message:`Collected ${material.materials.length} source-labelled text chunks from ${material.pages} lesson sources${material.incomplete ? '; gaps or limits remain' : ''}. Retaining course material.`})}`);
          break;
        }
      }
      if(mode==='quiz' && snapshot.question && observationFor(page).capturedQuestionId!==snapshot.question.id) {
        await captureCurrentView(page);
        const state=observationFor(page);
        const captured=await readSnapshot(page,mode);
        if(captured.snapshot.question?.id!==snapshot.question.id)continue;
        state.capturedQuestionId=snapshot.question.id;
        snapshot=captured.snapshot;handles=captured.handles;
      }
      if (playback) snapshot.playback=playback;
      if (playback?.question && !observationFor(page).imageQuestion?.includes(`${playback.identity}:${playback.slide}`)) {
        await captureCurrentView(page);
        const state=observationFor(page);
        if (state.image) snapshot.image=state.image;
        state.imageQuestion=[`${playback.identity}:${playback.slide}`];
      }
      if (coordinated && step === 1) snapshot.coordinationStart = true;
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: `Reading ${snapshot.title || 'the current course page'}.` })}`);
      const result = mode === 'quiz' ? recognizeQuizResult(snapshot) : null;
      if (result) { await terminalResult(result); return; }
      const timelineDelay=storylineTimelineWait(snapshot),timelineKey=snapshot.storylineKey;
      const waited=timelineWaits.get(timelineKey)||0;
      if(timelineDelay&&waited<120000){
        if(!waited)console.log(`LEARNER_PROGRESS ${JSON.stringify({message:'Waiting for the current narration and animation to finish.'})}`);
        timelineWaits.set(timelineKey,waited+timelineDelay);
        await new Promise(resolve=>setTimeout(resolve,timelineDelay));step-=1;continue;
      }
      let action;
      try {
        action = await reader.request(snapshot);
      } catch (error) {
        if (error?.message !== 'Learner step cap reached') throw error;
        break;
      }
      // The result can arrive while the provider is deciding. Re-observe even
      // for verify/ask-user so a terminal view wins before action/repeat guards.
      if(page.isClosed()) {step-=1;continue;}
      const current = await readSnapshot(page, mode);
      if (await finalizeCurrentStoryline()) return;
      if (playback) current.snapshot.playback=await readBrainshark(page);
      const currentResult = mode === 'quiz' ? recognizeQuizResult(current.snapshot) : null;
      if (currentResult) { await terminalResult(currentResult); return; }
      if(snapshot.question?.id!==current.snapshot.question?.id
        && !(action?.action==='answer-group' && snapshot.answerPageId && snapshot.answerPageId===current.snapshot.answerPageId)) {
        console.log(`Learner step ${step}: question changed while deciding; inspecting again`);
        continue;
      }
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
        await emitQuestion(question, page, browser);
        return;
      }
      let view = snapshot;
      let viewHandles = handles;
      if (action.action !== 'verify') {
        const revalidated = revalidateLearnerDecision(snapshot, current.snapshot, action);
        if (!revalidated.ok) {
          console.log(`Learner step ${step}: page changed while deciding; inspecting again`);
          continue;
        }
        action = revalidated.action;
        view = revalidated.snapshot || current.snapshot;
        viewHandles = current.handles;
      }
      const repeated = noteRepeatedLearnerAction(repeatState, action, view);
      repeatState = repeated.state;
      if (repeated.question) {
        console.log(`Learner step ${step}: repeated unchanged ${action.action}`);
        if(coordinated && coordinatedStalls<2) {
          coordinatedStalls++;
          let correction;
          try {correction=await reader.request({...current.snapshot,unchangedAction:true});}
          catch(error) {if(error?.message!=='Learner step cap reached')throw error;break;}
          if(page.isClosed()){step-=1;continue;}
          const fresh=await readSnapshot(page,mode);
          const coordinatedResult=mode==='quiz'?recognizeQuizResult(fresh.snapshot):null;
          if(coordinatedResult){await terminalResult(coordinatedResult);return;}
          if(!localActionAllowed(correction,current.snapshot,mode)) {finish(false,'rejected-action');return;}
          // Revalidate after the bounded coordinator exchange.
          const revalidated = revalidateLearnerDecision(current.snapshot, fresh.snapshot, correction);
          if (!revalidated.ok) continue;
          if(correction.action==='ask-user') {await emitQuestion(learnerQuestionPayload(current.snapshot,correction),page,browser);return;}
          action=revalidated.action;
          view=revalidated.snapshot || fresh.snapshot;viewHandles=fresh.handles;
        } else {
          await emitQuestion(repeated.question, page, browser);
          return;
        }
      }
      if (action.action === 'verify') {
        if (mode !== 'quiz' || !pageShowsPass(snapshot)) {
          console.log(`Learner step ${step}: page does not show a pass`);
          continue;
        }
        finish(true);
        return;
      }
      const popup = action.action === 'click' ? await watchCoursePopup(page) : null;
      let switched;
      try {
        switched = await applyAction(page, action, view, viewHandles, mode);
        if (['click', 'answer-select', 'answer-group'].includes(action.action)) delete observationFor(page).lastBlockedControl;
      } catch (error) {
        popup?.close();
        if (action.action === 'answer-group' && !page.isClosed()
          && (error instanceof CourseControlBlocked || error?.name === 'TimeoutError' || /element is not attached/i.test(error?.message || ''))) {
          observationFor(page).feedback = 'Grouped answers paused because the page or a control changed. Re-inspect the current answers and preserve this attempt; do not restart or submit automatically.';
          console.log('Grouped answers interrupted; preserving the current attempt and inspecting again.');
          continue;
        }
        if (!['click', 'answer-select'].includes(action.action) || page.isClosed()
          || !(error instanceof CourseControlBlocked || error?.name === 'TimeoutError' || /element is not attached|target changed/i.test(error?.message || ''))) throw error;
        const state = observationFor(page);
        const control = [...(view.buttons || []), ...(view.choices || [])].find(item => item.id === action.targetId);
        if (!coordinated && state.lastBlockedControl === control?.name) {
          await emitQuestion({
            question: `Vitriol could not use ${control?.name || 'the selected control'}. Can you open the next step in the course browser?`,
            options: ['Done, resume now'],
          }, page, browser);
          return;
        }
        state.lastBlockedControl = control?.name;
        state.blockedControl = true;
        state.feedback = `${action.action === 'answer-select' ? 'Selection of' : 'Click on'} ${control?.name || 'the selected control'} could not be confirmed. Check the current slide before trying again.`;
        console.log('Learner click blocked; asking for guidance on the fresh page.');
        continue;
      }
      if (switched) page = switched;
      const opened = popup && !switched ? await popup.resolve() : null;
      if (switched) popup?.close();
      if (opened) {
        landing = landing || originatingSabaPage(opened) || (/^https:\/\/hpi-external\.sabacloud\.com\//i.test(page.url()) ? page : null);
        page = opened;
        await protectSabaPopups(page);
        console.log('Following the course window opened by the selected control');
      }
      const target = [...(view.buttons || []), ...(view.choices || []), ...(view.tabs || [])].find((item) => item.id === action.targetId);
      const activity = action.action === 'answer-group' ? `Set and verified ${action.answers.length} answers. Checking the fresh page before continuing.` : action.action === 'select-tab' ? `Switched to ${target?.name || 'the selected course page'}.` : action.action === 'click' ? (target?.name?.startsWith('Course interaction:') ? 'Opened an interactive part of the course.' : `Opened ${target?.name || 'the selected control'}.`) : action.action === 'answer-select' ? `Selected ${target?.name || 'an answer'}.` : action.action === 'scroll' ? 'Scrolled to look for more course content.' : 'Checking the current page.';
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: activity })}`);
      console.log(`Learner step ${step}: ${action.action}`);
    }
    const { snapshot } = await readSnapshot(page, mode);
    const result = mode === 'quiz' ? recognizeQuizResult(snapshot) : null;
    if (result) { await terminalResult(result); return; }
    await emitQuestion({
      question: 'Vitriol reached its step limit. Resume to continue from the current course page.',
      options: ['Resume from this page'],
    }, page, browser);
  } finally {
    reader?.close();
    await closeBrainsharkReaders(browser.contexts()[0]?.pages() || []);
    await browser.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    finish(false, /Learner input (?:timed out|closed)|coordination.{0,30}timed out/i.test(error?.message || '') ? 'learner-interrupted' : 'learner-error');
  });
}

module.exports = {
  storylineTimelineWait,
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
  revalidateLearnerDecision,
  activateCourseExit,
  readCourseOutlines,
  clickLabelAllowed,
  screenElementControlName,
  noteRepeatedLearnerAction,
  observedQuestion,
  selectNativeSabaAnswer,
};
