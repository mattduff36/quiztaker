#!/usr/bin/env node
// pw-learn-quiz.js
//
// Confirmed quiz learner for a tab the hosted detector does not already solve.
// The script only reads the page and applies actions the control plane has
// already allowlisted. It has no API key and does not call the control plane.
// Submit, finish, exit, and grade controls are refused here even if a later
// step asks for them. Every page is sent to the provider with saved context;
// an ask-user action
// prints LEARNER_QUESTION and stops with needs-user-input. That is incomplete
// and never a successful completion. The same action and target on an unchanged
// view stops after three attempts and asks the operator to resume. Guidance is
// not a shell argument.
//
// Usage:
//   node pw-learn-quiz.js <tabIdx> [--dry]

const readline = require('node:readline');
const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const MAX_STEPS = 80;
const SUBMIT_LABEL = /\b(submit|finish|exit|end test|grade)\b/i;
const NAVIGATION_LABEL = /^(next(?: page| slide)?|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch|resume|menu|home|contents)$/i;
const OPEN_TOPIC_LABEL = /^Open topic: .{1,140}$/;
const COURSE_INTERACTION_LABEL = /^Course interaction: \d+_\d+_click_?\d+$/;
const REPEATED_VIEW_LIMIT = 3;
const REPEATED_VIEW_OPTION = 'Done, resume now';
const PASS_EVIDENCE = /\byou passed\b|\byour score:\s*100\s*%/i;
const FAIL_EVIDENCE = /\b(not passed|did not pass|failed|unsuccessful|not successful)\b/i;
const ALLOWED = new Set(['click', 'answer-select', 'scroll', 'wait', 'capture', 'verify', 'ask-user']);
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

function localActionAllowed(action, snapshot) {
  if (!action || typeof action !== 'object') return false;
  if (!ALLOWED.has(action.action)) return false;
  if (action.action === 'ask-user') return learnerQuestionPayload(snapshot, action) != null;
  if (action.action === 'click' || action.action === 'answer-select') {
    const pool = action.action === 'click' ? snapshot.buttons : snapshot.choices;
    const target = (pool || []).find((item) => item.id === action.targetId);
    if (!target || SUBMIT_LABEL.test(target.name)) return false;
    if (action.action === 'click' && !clickLabelAllowed(target.name)) return false;
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
    return (explicit?.textContent || wrapping?.textContent || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value') || '');
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

async function readControls(page, role, prefix, navigationOnly) {
  const listed = [];
  const handles = new Map();
  for (const frame of await visibleFrames(page)) {
    const locator = navigationOnly ? frame.locator('button, a, [role=button], [onclick], input[type=button]') : frame.getByRole(role);
    const count = Math.min(await locator.count().catch(() => 0), 120);
    for (let index = 0; index < count; index += 1) {
      const handle = locator.nth(index);
      if (!await handle.isVisible().catch(() => false) || !await handle.isEnabled().catch(() => false)) continue;
      const name = await accessibleName(handle);
      if (!name || SUBMIT_LABEL.test(name)) continue;
      if (navigationOnly && !clickLabelAllowed(name)) continue;
      if (await isSubmitControl(handle)) continue;
      const id = `${prefix}${listed.length + 1}`;
      handles.set(id, handle);
      listed.push({ id, name });
      if (listed.length >= 40) return { listed, handles };
    }
  }
  return { listed, handles };
}

async function readSnapshot(page) {
  let text = '';
  for (const frame of await visibleFrames(page)) {
    try {
      text += `\n${await frame.locator('body').innerText({ timeout: 2000 })}`;
    } catch {
      // A cross-origin frame has no readable body.
    }
    if (text.length > 6000) break;
  }
  const buttons = await readControls(page, 'button', 'b', true);
  const radios = await readControls(page, 'radio', 'c', false);
  const checks = await readControls(page, 'checkbox', 'k', false);
  const handles = new Map([...buttons.handles, ...radios.handles, ...checks.handles]);
  return {
    snapshot: {
      title: await page.title().catch(() => ''),
      url: page.url(),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 6000),
      buttons: buttons.listed,
      choices: [...radios.listed, ...checks.listed],
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

async function applyAction(page, action, snapshot, handles) {
  if (action.action === 'scroll') {
    await page.mouse.wheel(0, 400);
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
  if (action.action === 'click') {
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
  const browser = await chromium.connectOverCDP(CDP_URL);
  let reader = null;
  try {
    let page = browser.contexts()[0]?.pages()?.[options.tabIdx];
    if (!page) throw new Error('Tab index is not open');
    if (options.dryRun) {
      const { snapshot } = await readSnapshot(page);
      console.log(`Dry run: quiz-learn observed "${snapshot.title || 'untitled'}"`);
      return;
    }
    reader = createActionReader();
    let repeatState = null;
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const { snapshot, handles } = await readSnapshot(page);
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: `Reading ${snapshot.title || 'the current course page'}.` })}`);
      if (pageShowsPass(snapshot)) { finish(true); return; }
      const action = await reader.request(snapshot);
      if (!localActionAllowed(action, snapshot)) {
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
        const current = await readSnapshot(page);
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
        if (!pageShowsPass(snapshot)) {
          console.log(`Learner step ${step}: page does not show a pass`);
          continue;
        }
        finish(true);
        return;
      }
      const popup = action.action === 'click' ? page.waitForEvent('popup', { timeout: 2500 }).catch(() => null) : null;
      await applyAction(page, action, view, viewHandles);
      const opened = popup ? await popup : null;
      if (opened) {
        await opened.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        page = opened;
        console.log('Following the course window opened by the selected control');
      }
      const target = [...(view.buttons || []), ...(view.choices || [])].find((item) => item.id === action.targetId);
      const activity = action.action === 'click' ? (target?.name?.startsWith('Course interaction:') ? 'Opened an interactive part of the course.' : `Opened ${target?.name || 'the selected control'}.`) : action.action === 'answer-select' ? `Selected ${target?.name || 'an answer'}.` : action.action === 'scroll' ? 'Scrolled to look for more course content.' : 'Checking the current page.';
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
  visibleFrames,
  sameLearnerView,
  clickLabelAllowed,
  screenElementControlName,
  noteRepeatedLearnerAction,
};
