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
//
// Usage:
//   node pw-learn-quiz.js <tabIdx> [--dry]

const readline = require('node:readline');
const { chromium } = require('playwright');
const { observePlayerEvidence } = require('./lib/player-evidence');
const { recognizeQuizResult, quizResultPayload } = require('./lib/quiz-result');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const MAX_STEPS = 80;
const SUBMIT_LABEL = /\b(submit|finish|end test|end quiz|grade)\b/i;
const UNSAFE_LABEL = /\b(log\s*out|sign\s*out|sign\s*in|log\s*in|password|account|payment|purchase|buy|delete|remove|unsubscribe|exit|close browser)\b/i;
const ASSESSMENT_START_LABEL = /\b(?:(?:start|begin|launch|take)(?:\s+the)?\s+(?:test|quiz|assessment)|retake|retry)\b/i;
const NAVIGATION_LABEL = /^(next(?: page| slide)?|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch|resume|menu|home|contents)$/i;
const OPEN_TOPIC_LABEL = /^Open topic: .{1,140}$/;
const COURSE_INTERACTION_LABEL = /^Course interaction: \d+_\d+_click_?\d+$/;
const REPEATED_VIEW_LIMIT = 3;
const REPEATED_VIEW_OPTION = 'Done, resume now';
const ALLOWED = new Set(['click', 'answer-select', 'select-tab', 'scroll', 'find-text', 'wait', 'capture', 'verify', 'ask-user']);
const observationState = new WeakMap();
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
  return `${name}\u0000${targetId}\u0000${name === 'scroll' ? action?.direction || 'down' : ''}\u0000${action?.text || ''}`;
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
  if (action.action === 'scroll') return action.direction == null || action.direction === 'up' || action.direction === 'down';
  if (action.action === 'find-text') return typeof action.text === 'string' && action.text.trim().length > 0 && action.text.length <= 160;
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
    if (action.action === 'answer-select' && target.checked === true) return false;
    if (action.action === 'click') {
      if (mode === 'quiz' && recognizeQuizResult(snapshot)) return false;
      if (UNSAFE_LABEL.test(target.name)) return false;
      const radios = (snapshot.choices || []).filter(choice => /^c\d+$/.test(choice.id));
      if (mode === 'quiz' && /^next(?: page| slide)?[ »›→]*$/i.test(target.name.trim()) && /\bQuestion\s+\d+\s+of\s+\d+\b/i.test(snapshot.text || '')
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
        const slide = /^(\d+_\d+)_click_?\d+$/.exec(parent.id || '');
        if (slide && parent.ownerDocument) {
          const visible = node => {
            if (!node || !node.getClientRects().length) return false;
            for (let item = node; item; item = item.parentElement) {
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
  return normalized || (await locator.evaluate(dkiInformationIcon).catch(() => null))?.name || '';
}

async function answerName(handle) {
  const name = await accessibleName(handle);
  if (!name) return '';
  const question = await handle.evaluate(el => {
    const block = el.closest('fieldset.testEngine-question')?.parentElement;
    return block?.innerText?.trim().match(/^Question\s+(\d+)\s+of\s+\d+\b/i)?.[1];
  }).catch(() => undefined);
  return question ? `Q${question}: ${name}`.slice(0,160) : name;
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
    const url=canonicalCourseSource(frame.url());
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
    const address=canonicalCourseSource(frame.url());
    if(/\b(?:login\d*|signin|sign-in|oauth|sso|authenticate)\b/i.test(address)) {state.feedback='Screenshot skipped on an authentication page.';return;}
    const sensitive=frame.locator('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[name*=password i],input[id*=password i],input[name*=token i],input[id*=token i],input[name*=secret i],input[id*=secret i],input[name*=api_key i],input[id*=api_key i],input[name*=apikey i],input[id*=apikey i],textarea[name*=secret i],form[action*=login i],form[action*=signin i]');
    const count=await sensitive.count().catch(()=>-1);
    if(count<0 || count>50){state.feedback='Screenshot skipped: sensitive fields could not be checked safely.';return;}
    for(let index=0;index<count;index++) if(await sensitive.nth(index).isVisible().catch(()=>true)) {state.feedback='Screenshot skipped because an authentication or sensitive field is visible.';return;}
  }
  try {
    const jpeg=await page.screenshot({type:'jpeg',quality:55,fullPage:false,scale:'css',timeout:10_000});
    const image=`data:image/jpeg;base64,${jpeg.toString('base64')}`;
    if(image.length>MAX_CAPTURE_DATA_URL){state.feedback='Screenshot skipped because the viewport image exceeds the size limit.';return;}
    state.image=image;state.imageUrl=page.url();state.feedback='A viewport screenshot was captured by the last capture action.';
  } catch {state.feedback='The viewport screenshot was unavailable. Continue using the observed text and controls.';}
}

async function findRenderedText(page,text) {
  for(const frame of await visibleFrames(page)) {
    const matches=frame.getByText(text,{exact:false}).filter({visible:true});
    const count=Math.min(await matches.count().catch(()=>0),50);
    for(let index=0;index<count;index++) {
      const target=matches.nth(index);
      const facing=await target.evaluate(el=>{
        for(let face=el;face;face=face.parentElement) {
          if(getComputedStyle(face).backfaceVisibility!=='hidden')continue;
          let matrix=new DOMMatrix();
          for(let node=face;node;node=node.parentElement){const transform=getComputedStyle(node).transform;if(transform!=='none')matrix=new DOMMatrix(transform).multiply(matrix);}
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
  const handles = new Map();
  const candidates = [];
  const counts = { c: 0, k: 0 };
  const viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
  for (const frame of await visibleFrames(page)) {
    const box = frame.parentFrame() ? await frame.frameElement().then(element => element.boundingBox()).catch(() => null) : {x:0,y:0};
    if (!box) continue;
    const locator = navigationOnly ? frame.locator('button, a, [role=button], [role=tab], summary, [onclick], [data-toggle], [data-bs-toggle], [aria-controls], input[type=button], input[type=submit], input[type=image], .dki-element-content.speech-bubble, img.dki-element-content.hasRollover, img.dki-element-content.dki-image-rollover[data-id]') : role === 'answer' ? frame.getByRole('radio').or(frame.getByRole('checkbox')) : frame.getByRole(role);
    const indices = await locator.evaluateAll((elements, view) => {
      const indices = [];
      for (let index = 0; index < elements.length; index += 1) {
        const el = elements[index];
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!el.getClientRects().length || !rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
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
        const inViewport = rect.bottom > Math.max(0,view.top) && rect.top < Math.min(innerHeight,view.bottom)
          && rect.right > Math.max(0,view.left) && rect.left < Math.min(innerWidth,view.right);
        const explicitRole = el.getAttribute('role')?.trim().split(/\s+/)[0];
        const checkbox = explicitRole ? explicitRole === 'checkbox' : el.matches('input[type=checkbox]');
        indices.push({index,inViewport,checkbox});
      }
      return indices;
    }, {left:-box.x,top:-box.y,right:viewport.width-box.x,bottom:viewport.height-box.y}).catch(() => []);
    for (const candidate of indices) candidates.push({locator,...candidate});
  }
  // Stable viewport-first order makes a scroll reveal later modules, while
  // keeping offscreen course controls as an auto-scroll fallback.
  candidates.sort((a,b) => Number(b.inViewport)-Number(a.inViewport));
  for (const {locator,index,checkbox} of candidates.slice(0,120)) {
    const handle = locator.nth(index);
    if (!await handle.isVisible().catch(() => false) || !await handle.isEnabled().catch(() => false)) continue;
    const name = role === 'answer' ? await answerName(handle) : await accessibleName(handle);
    if (!name || (navigationOnly && UNSAFE_LABEL.test(name))) continue;
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
      if (!link.safe) continue;
      const submits = await isSubmitControl(handle);
      // Form/postback navigation can consume assessment state; it is quiz-only
      // even when labelled Next rather than a final Submit control.
      kind = SUBMIT_LABEL.test(name) ? 'submission' : submits || link.postback || ASSESSMENT_START_LABEL.test(name) || /^(save|return later|summary)\b/i.test(name) ? 'quiz-navigation' : 'content';
      if (mode !== 'quiz' && (kind === 'submission' || kind === 'quiz-navigation')) continue;
    }
    const answerPrefix = checkbox ? 'k' : 'c';
    const id = role === 'answer' ? `${answerPrefix}${++counts[answerPrefix]}` : `${prefix}${listed.length + 1}`;
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
    listed.push({ id, name, ...(kind ? { kind } : {}), ...(typeof checked === 'boolean' ? {checked} : {}) });
    if (listed.length >= 40) return { listed, handles };
  }
  return { listed, handles };
}

async function readSnapshot(page, mode = 'read') {
  const sections = [];
  const resultViews = [];
  for (const frame of await visibleFrames(page)) {
    try {
      let exposed = true;
      for (let child = frame; child.parentFrame(); child = child.parentFrame()) {
        const element = await child.frameElement();
        exposed = await element.evaluate(el => {
          const r = el.getBoundingClientRect();
          if (!(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return false;
          for (let face = el; face; face = face.parentElement) {
            const style = getComputedStyle(face);
            if (Number(style.opacity) === 0) return false;
            if (style.backfaceVisibility !== 'hidden') continue;
            let matrix = new DOMMatrix();
            for (let node = face; node; node = node.parentElement) {
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
          for (let face = el; face; face = face.parentElement) {
            if (Number(getComputedStyle(face).opacity) === 0) return false;
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
      resultViews.push(observed.text);
      const source = frame.url().split(/[?#]/)[0].slice(0, 500);
      sections.push(`[Source: ${source} | ${observed.heading || ''} | scroll ${observed.position}${observed.end ? ' | end of page' : ''}]\n${observed.text}`);
    } catch {
      // A cross-origin frame has no readable body.
    }
  }
  const buttons = await readControls(page, 'button', 'b', true, mode);
  const answers = await readControls(page, 'answer', '', false);
  const handles = new Map([...buttons.handles, ...answers.handles]);
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
  const image=state.imageUrl===page.url()?state.image:undefined;
  delete state.image;delete state.imageUrl;
  const snapshot = {
      title: (await page.title().catch(() => '')).slice(0,200),
      url: page.url().slice(0,500),
      text: `${await observePlayerEvidence(page)}\n${state.feedback?`Tool feedback: ${state.feedback}\n`:''}${sections.map(section => section.slice(0, Math.floor(7400 / Math.max(1, sections.length)))).join('\n')}`.slice(0, 8000),
      buttons: buttons.listed,
      choices: answers.listed,
      tabs,
      ...(image?{image}:{}),
      ...(outlines.length?{outlines}:{}),
  };
  // Raw live text is local verification evidence, not additional provider
  // context. Exclude it from JSON and never populate it from course memory.
  Object.defineProperty(snapshot, 'resultViews', {value: resultViews});
  return {snapshot, handles};
}

function sameLearnerView(before, after) {
  const comparable = value => {
    if (!value || typeof value !== 'object') return value;
    const { image, ...view } = value;
    // Canon renders this labelled countdown as its own text line. Answers,
    // question text, expiry notices and every other page change stay significant.
    if (typeof view.text === 'string') view.text = view.text.replace(/(^|\n)(Time remaining[ \t]*\n)\d{1,3}:\d{2}(?::\d{2})?(?=\n|$)/gi, '$1$2[countdown]');
    return view;
  };
  return JSON.stringify(comparable(before)) === JSON.stringify(comparable(after));
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
  const state=observationFor(page);delete state.feedback;
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
    for (const frame of await visibleFrames(page)) await frame.evaluate(direction => window.scrollBy(0, (direction==='up'?-1:1)*Math.max(300, innerHeight * 0.8)),action.direction||'down').catch(() => undefined);
    await page.waitForTimeout(100);
    return;
  }
  if(action.action==='find-text') {
    const found=await findRenderedText(page,action.text.trim());
    state.feedback=found?`Found rendered text: ${action.text.trim()}`:`Text was not found in rendered course content: ${action.text.trim()}`;
    return;
  }
  if (action.action === 'wait') {
    const ms = Math.max(0, Math.min(1000, Number(action.ms) || 500));
    await page.waitForTimeout(ms);
    return;
  }
  if (action.action === 'capture') {
    await captureCurrentView(page);
    return;
  }
  const handle = handles.get(action.targetId);
  if (!handle) throw new Error('Learner target is not on the page');
  const target = [...(snapshot.buttons || []), ...(snapshot.choices || [])].find(item => item.id === action.targetId);
  if (!await handle.isVisible() || !await handle.isEnabled() || (await (action.action === 'answer-select' ? answerName(handle) : accessibleName(handle))) !== target?.name) throw new Error('Learner target changed');
  if (action.action === 'click') {
    if (await handle.evaluate(dkiInformationIcon).catch(() => null)) {
      if (!await handle.isVisible() || !await handle.isEnabled()) throw new Error('Learner target changed');
      // Pointer movement creates a covering rollover image on these DKI icons.
      // Activate the validated visible representative without triggering hover.
      await handle.dispatchEvent('click');
    } else await handle.click({ timeout: 5000 });
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

function finish(completed, reason, result) {
  const payload = result ? quizResultPayload(result) : completed
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
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const { snapshot, handles } = await readSnapshot(page, mode);
      console.log(`LEARNER_PROGRESS ${JSON.stringify({ message: `Reading ${snapshot.title || 'the current course page'}.` })}`);
      const result = mode === 'quiz' ? recognizeQuizResult(snapshot) : null;
      if (result) { finish(result.status === 'passed', undefined, result); return; }
      const action = await reader.request(snapshot);
      // The result can arrive while the provider is deciding. Re-observe even
      // for verify/ask-user so a terminal view wins before action/repeat guards.
      const current = await readSnapshot(page, mode);
      const currentResult = mode === 'quiz' ? recognizeQuizResult(current.snapshot) : null;
      if (currentResult) { finish(currentResult.status === 'passed', undefined, currentResult); return; }
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
      const switched = await applyAction(page, action, view, viewHandles, mode);
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
  readCourseOutlines,
  clickLabelAllowed,
  screenElementControlName,
  noteRepeatedLearnerAction,
};
