#!/usr/bin/env node
/**
 * Passive selected-tab course recorder: node pw-quick-scrape.js <numeric tab index>
 * Attaches over PLAYWRIGHT_CDP_URL (default localhost:9222); never launches,
 * clicks, submits, reads input values, or closes the user's browser/tabs.
 * Type finish + Enter, stop + Enter, send SIGINT/SIGTERM, or close the tab to stop.
 *
 * QUIZTAKER_HOME/data/quick-scrape/<unique-id> contains replay.html (standalone,
 * no server/network needed), timestamped JPEGs, frames.js, transcript.jsonl,
 * transcript.txt and result.json. Files are written progressively; replay works
 * before finish and after a crash. stdout emits QUICK_SCRAPE_READY {folder},
 * QUICK_SCRAPE_PAGE {title,url,text} (<=5000 characters per chunk), and
 * QUICK_SCRAPE_RESULT {folder,pages,frames,reason}. Warnings go to stderr.
 *
 * Limits: 15 minutes, 200 MiB, 4500 JPEGs, 10000 screen chunks, 8 frames,
 * 20000 text characters/screen, 32 buffered observations/frame, 5 visual fps,
 * 20 transcript polls/sec. Text observes DOM mutations and human clicks;
 * image/canvas/video changes are sampled, not lossless. Very brief states may
 * be missed. No OCR/AI/audio. Only the selected tab and up to 2 direct same-origin
 * popups are eligible. Other tabs are never inspected.
 *
 * Only the selected HTTPS course origin is allowed (including Canon and Xerox). Authentication/account/payment
 * pages and frames are skipped. All editable controls are omitted/masked;
 * other-origin frames are masked. URLs lose query, fragment, userinfo and
 * semicolon parameters. Potential credential assignments/emails are redacted.
 * A privacy gate runs before and after each JPEG; unsafe transitions discard it.
 * Course content must itself be non-sensitive; this is not a general browser
 * recorder or a guarantee against secrets embedded in arbitrary course images.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { USER_HOME } = require('./lib/paths');

const DEFAULT_LIMITS = Object.freeze({
  durationMs: 15 * 60 * 1000, bytes: 200 * 1024 * 1024, frames: 4500,
  pages: 10000, pollMs: 50, visualMs: 200, frameBytes: 2 * 1024 * 1024,
});
const SENSITIVE_PATH = /(?:^|[/_.;-])(login|signin|sign-in|sso|oauth|authorize|auth|account|profile|payment|checkout|password|credential|token)(?:[/_.;-]|$)/i;

function courseUrl(raw, origins = []) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && origins.includes(url.origin) && !url.username && !url.password
      && !SENSITIVE_PATH.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

function sanitizedUrl(raw, origins = []) {
  if (!courseUrl(raw, origins)) return '[excluded]';
  const url = new URL(raw);
  return url.origin + url.pathname.split(';')[0];
}

function cleanText(value, origins = []) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>"')]+/gi, raw => sanitizedUrl(raw, origins))
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email redacted]')
    .replace(/\b(password|passwd|secret|token|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

// Executed in a single frame. Never access .value, cookies, storage or globals
// belonging to the course. The queue preserves short-lived DOM states.
function observeFrame({ key, allowed, drain = false, stop = false }) {
  if (stop) {
    const previous = window[key];
    if (previous) {
      previous.observer.disconnect();
      clearTimeout(previous.timer);
      document.removeEventListener('click', previous.click, true);
      delete window[key];
    }
    return null;
  }
  const sensitive = /(?:^|[/_.;-])(login|signin|sign-in|sso|oauth|authorize|auth|account|profile|payment|checkout|password|credential|token)(?:[/_.;-]|$)/i;
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const safe = () => {
    if (!allowed.includes(location.origin) || sensitive.test(decodeURIComponent(location.pathname))) return false;
    if (/\b(sign\s*in|log\s*in|password|payment|your account)\b/i.test(document.title)) return false;
    for (const el of Array.from(document.querySelectorAll('h1,h2,[role=heading]')).slice(0, 50)) {
      if (visible(el) && /\b(sign\s*in|log\s*in|reset password|verify your identity|payment details)\b/i.test(el.innerText)) return false;
    }
    for (const el of document.querySelectorAll('input,textarea,[contenteditable],form')) {
      if (!visible(el)) continue;
      if (el.matches('input[type=password],input[type=email],input[autocomplete=username],input[autocomplete=current-password],input[autocomplete=new-password]')) return false;
      if (/\b(password|passwd|credential|credit.card|one.time|otp|sign.?in|log.?in)\b/i.test(
        `${el.getAttribute('name') || ''} ${el.id} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('action') || ''}`)) return false;
    }
    return true;
  };
  if (!safe()) {
    if (window[key]) window[key].queue.length = 0;
    return { safe: false, events: [] };
  }
  if (!window[key]) {
    const state = { queue: [], last: '', lastAt: 0, timer: null };
    const snapshot = clicked => {
      if (!safe()) { state.queue.length = 0; return; }
      state.lastAt = Date.now();
      let text = '';
      let visited = 0;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()) && text.length < 20000 && visited++ < 12000;) {
        const el = node.parentElement;
        if (!el || el.closest('script,style,noscript,input,textarea,select,[contenteditable]') || !visible(el)) continue;
        const part = node.textContent.replace(/\s+/g, ' ').trim();
        if (part) text += `${part}\n`;
      }
      // Non-text accessible labels and image alternatives are useful on slides.
      for (const el of Array.from(document.querySelectorAll('[aria-label],img[alt]')).slice(0, 300)) {
        if (text.length >= 20000) break;
        if (!visible(el) || el.closest('input,textarea,select,[contenteditable]')) continue;
        const label = el.getAttribute('aria-label') || el.getAttribute('alt');
        if (label) text += `[label] ${label.slice(0, 300)}\n`;
      }
      text = text.slice(0, 20000);
      if (text === state.last && !clicked) return;
      state.last = text;
      state.queue.push({ at: Date.now(), title: document.title.slice(0, 300), text,
        clicked: clicked || '', url: location.origin + location.pathname.split(';')[0] });
      if (state.queue.length > 32) state.queue.shift();
    };
    state.click = event => {
      const el = event.target instanceof Element ? event.target.closest('button,a,[role=button],label,input[type=radio],input[type=checkbox]') : null;
      if (!el || el.closest('[contenteditable]')) return;
      const label = el.getAttribute('aria-label') || (el.tagName === 'INPUT' ? el.labels?.[0]?.innerText : el.innerText) || el.getAttribute('title') || el.tagName;
      snapshot(String(label).slice(0, 200));
    };
    state.observer = new MutationObserver(() => {
      if (Date.now() - state.lastAt >= 25) snapshot('');
      else if (!state.timer) state.timer = setTimeout(() => { state.timer = null; snapshot(''); }, 25);
    });
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener('click', state.click, true);
    window[key] = state;
    snapshot('');
  }
  return { safe: true, events: drain ? window[key].queue.splice(0) : [] };
}

const REPLAY = `<!doctype html><meta charset="utf-8"><title>Quick scrape replay</title>
<style>body{background:#181818;color:#eee;font:16px system-ui;margin:16px}img{display:block;max-width:100%;max-height:85vh}input{width:60%}button{margin:8px}</style>
<h1>Course recording</h1><p>Local JPEG replay. Reload to include newly recorded frames.</p>
<button id="play">Play / pause</button><input id="seek" type="range" min="0" value="0"><span id="time"></span><img id="frame" alt="Recorded course frame">
<script>window.quickScrapeFrames=[];</script>
<script>
const frames=window.quickScrapeFrames,seek=document.getElementById('seek'),image=document.getElementById('frame'),label=document.getElementById('time');
let index=0,timer=null;seek.max=Math.max(0,frames.length-1);
function show(){const f=frames[index];if(!f){label.textContent='Waiting for first safe frame';return}seek.value=index;image.src=f.file;label.textContent=new Date(f.at).toISOString()+' ('+(index+1)+'/'+frames.length+')'}
function step(){if(index>=frames.length-1){timer=null;return}const delay=Math.max(40,Math.min(10000,frames[index+1].at-frames[index].at));timer=setTimeout(()=>{index++;show();step()},delay)}
seek.oninput=()=>{clearTimeout(timer);timer=null;index=Number(seek.value);show()};
document.getElementById('play').onclick=()=>{if(timer){clearTimeout(timer);timer=null}else{if(index>=frames.length-1)index=0;show();step()}};show();
</script>`;

function parseArgs(argv) {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0]) || !Number.isSafeInteger(Number(argv[0]))) {
    throw new Error('Usage: node pw-quick-scrape.js <numeric tab index>');
  }
  return Number(argv[0]);
}

async function startRecorder(page, options = {}) {
  const selected = new URL(page.url());
  const origins = [selected.origin];
  if (options.expectedUrl && options.expectedUrl !== page.url()) throw new Error('The selected course tab changed. Refresh the tabs and try again.');
  if (!courseUrl(page.url(), origins)) throw new Error('Selected tab is not an allowed course page');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const emit = options.emit || ((kind, value) => process.stdout.write(`${kind} ${JSON.stringify(value)}\n`));
  const warn = options.warn || (message => process.stderr.write(`Quick scrape: ${message}\n`));
  const root = path.join(options.home || USER_HOME, 'data', 'quick-scrape');
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'recording-'));
  let bytes = 0, pages = 0, frames = 0, reason = '', running = false;
  let lastVisual = 0, lastHash = '', failure = null;
  const started = Date.now();
  const key = `__quickScrape_${crypto.randomBytes(12).toString('hex')}`;
  const targets = new Set([page]);
  const pending = [];
  const frameIds = new WeakMap();
  let nextFrameId = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const write = (name, data, append = false) => {
    const size = Buffer.byteLength(data);
    if (bytes + size > limits.bytes) { requestStop('disk-limit'); return false; }
    if (append) fs.appendFileSync(path.join(folder, name), data);
    else fs.writeFileSync(path.join(folder, name), data);
    bytes += size;
    return true;
  };
  function requestStop(why = 'stop') { if (!reason) reason = why; }
  const onClose = () => requestStop('page-closed');
  const onPopup = popup => {
    if (targets.size >= 3) return;
    // Blank popups are not followed: no inspection before origin is known.
    if (courseUrl(popup.url(), origins) && new URL(popup.url()).origin === new URL(page.url()).origin) targets.add(popup);
  };
  page.on('close', onClose);
  page.on('popup', onPopup);
  write('replay.html', REPLAY);
  write('frames.js', 'window.quickScrapeFrames=[];\n');
  write('transcript.jsonl', '');
  write('transcript.txt', '');
  let ready = false;

  async function inspect(target, drain) {
    if (target.isClosed() || !courseUrl(target.url(), origins)) return null;
    const result = [];
    for (const frame of target.frames().slice(0, 8)) {
      if (!courseUrl(frame.url(), origins)) { result.push({ frame, safe: false }); continue; }
      let state;
      try { state = await frame.evaluate(observeFrame, { key, allowed: origins, drain }); }
      catch (error) {
        if (!target.isClosed() && !/detached|destroyed|navigation|closed/i.test(error.message)) throw error;
        return null;
      }
      if (!frameIds.has(frame)) frameIds.set(frame, `frame-${++nextFrameId}`);
      result.push({ frame, ...state });
    }
    return result[0]?.safe ? result : null;
  }

  function collect(states) {
    for (const state of states || []) {
      for (const event of state.events || []) pending.push({ ...event, frame: frameIds.get(state.frame) });
    }
  }

  function persist(watermark = Infinity) {
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= watermark) {
      const event = pending.shift();
      const title = cleanText(event.title, origins).slice(0, 300);
      const url = sanitizedUrl(event.url, origins);
      const clicked = cleanText(event.clicked, origins).slice(0, 200);
      const text = cleanText(event.text, origins);
      for (let offset = 0; offset < Math.max(1, text.length); offset += 5000) {
        if (pages >= limits.pages) { requestStop('page-limit'); return; }
        const chunk = text.slice(offset, offset + 5000);
        const entry = { at: event.at, frame: event.frame, title, url, text: chunk, clicked };
        if (!write('transcript.jsonl', JSON.stringify(entry) + '\n', true)) return;
        if (!write('transcript.txt', `[${new Date(event.at).toISOString()} ${entry.frame}] ${title}\n${url}\n${clicked ? `Clicked: ${clicked}\n` : ''}${chunk}\n\n`, true)) return;
        pages++;
        emit('QUICK_SCRAPE_PAGE', { title, url, text: chunk });
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (Date.now() - started >= limits.durationMs) requestStop('duration-limit');
      const watermark = Date.now();
      const observations = [];
      for (const target of targets) {
        if (reason) break;
        const states = await inspect(target, true);
        if (!states) continue;
        collect(states);
        observations.push({ target, states });
      }
      persist(watermark);
      for (const { target, states } of observations.reverse()) {
        if (reason || Date.now() - lastVisual < limits.visualMs) continue;
        lastVisual = Date.now();
        if (frames >= limits.frames) { requestStop('frame-limit'); break; }
        // Mask every editable element, even if currently empty, and every
        // unapproved child frame. Include unexamined frames beyond the cap.
        const mask = [target.locator('input,textarea,select,[contenteditable]')];
        const safeFrames = new Set(states.filter(state => state.safe).map(state => state.frame));
        for (const frame of target.frames()) {
          if (frame === target.mainFrame()) continue;
          if (safeFrames.has(frame)) mask.push(frame.locator('input,textarea,select,[contenteditable]'));
          else {
            const parent = frame.parentFrame();
            if (parent) mask.push(parent.locator('iframe,frame'));
          }
        }
        const dimensions = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (dimensions.width * dimensions.height > 8000000) { requestStop('viewport-limit'); break; }
        const before = states.map(state => `${state.frame.url()}:${state.safe}`).join('\n');
        const jpeg = await target.screenshot({
          type: 'jpeg', quality: 55, fullPage: false, scale: 'css', mask, timeout: 3000,
          style: 'input,textarea,select,[contenteditable]{visibility:hidden!important}',
        });
        if (reason) break;
        const after = await inspect(target, false);
        if (!after || before !== after.map(state => `${state.frame.url()}:${state.safe}`).join('\n')) continue;
        if (jpeg.length > limits.frameBytes) { requestStop('frame-byte-limit'); break; }
        const hash = crypto.createHash('sha256').update(jpeg).digest('hex');
        if (hash === lastHash) continue;
        const at = Date.now();
        const file = `${String(frames).padStart(6, '0')}-${at}.jpg`;
        if (!write(file, jpeg)) break;
        if (!write('frames.js', `window.quickScrapeFrames.push(${JSON.stringify({ at, file })});\n`, true)) break;
        // Independent script blocks keep earlier frames playable even if the
        // process dies halfway through the final append.
        if (!write('replay.html', `\n<script>quickScrapeFrames.push(${JSON.stringify({ at, file })});seek.max=quickScrapeFrames.length-1;if(quickScrapeFrames.length===1)show();</script>\n`, true)) break;
        frames++;
        lastHash = hash;
        if (!ready) { ready = true; emit('QUICK_SCRAPE_READY', { folder }); }
      }
    } catch (error) {
      if (page.isClosed()) requestStop('page-closed');
      else {
        failure = error;
        warn('Capture failed; partial recording preserved.');
        requestStop('capture-error');
      }
    } finally {
      running = false;
      if (reason) await finish();
    }
  }

  let finished = false;
  async function finish() {
    if (finished || running) return;
    finished = true;
    clearInterval(timer);
    page.off('close', onClose);
    page.off('popup', onPopup);
    if (['finish', 'stop', 'signal', 'stdin-closed', 'duration-limit', 'page-closed'].includes(reason)) {
      for (const target of targets) {
        try { collect(await inspect(target, true)); }
        catch (error) {
          failure ||= error;
          warn('Final transcript drain failed; earlier observations preserved.');
        }
      }
      persist();
    }
    for (const target of targets) {
      if (target.isClosed()) continue;
      for (const frame of target.frames()) {
        if (!courseUrl(frame.url(), origins)) continue;
        try { await frame.evaluate(observeFrame, { key, allowed: origins, stop: true }); }
        catch (error) {
          if (!/detached|destroyed|navigation|closed/i.test(error.message)) warn('Could not remove a frame observer.');
        }
      }
    }
    const result = { folder, pages, frames, reason };
    // Reserve final metadata independently of the capture budget.
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
    emit('QUICK_SCRAPE_RESULT', result);
    resolveDone({ ...result, error: failure });
  }
  const timer = setInterval(() => { void tick(); }, limits.pollMs);
  await tick();
  return { folder, done, stop: (why = 'stop') => { requestStop(why); if (!running) void finish(); } };
}

async function main(argv = process.argv.slice(2)) {
  const index = parseArgs(argv);
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222');
  let input, recorder;
  const signal = () => recorder?.stop('signal');
  try {
    const page = browser.contexts().flatMap(context => context.pages())[index];
    if (!page) throw new Error('Selected tab does not exist');
    recorder = await startRecorder(page, {expectedUrl:process.env.VITRIOL_CAPTURE_TARGET});
    input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => {
      if (/^(finish|stop)$/i.test(line.trim())) recorder.stop(line.trim().toLowerCase());
    });
    input.on('close', () => recorder.stop('stdin-closed'));
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    const result = await recorder.done;
    if (result.error) process.exitCode = 1;
  } finally {
    input?.close();
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    // Closing a CDP connection disconnects Playwright; it does not close Chrome.
    await browser.close();
  }
}

module.exports = { startRecorder, parseArgs, courseUrl, sanitizedUrl, cleanText, main };
if (require.main === module) main().catch(() => {
  process.stderr.write('Quick scrape failed: check the numeric tab index, course origin and local CDP connection.\n');
  process.exitCode = 1;
});
