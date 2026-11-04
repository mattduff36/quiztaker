'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { startRecorder, parseArgs, courseUrl, sanitizedUrl, cleanText, main } = require('./pw-quick-scrape');

const ORIGIN = 'https://canon-europe.csod.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail(`Timed out: ${description}`);
}

const HTML = `<!doctype html><title>Fixture course</title>
<style>body{font:20px sans-serif;background:white}#art{width:250px;height:150px;background:red}
#overlay{position:fixed;inset:60px;background:white;border:10px solid blue;padding:30px}</style>
<h1>Slide 0</h1><button id="next">Next slide</button><button id="open">Open overlay</button>
<div id="art" role="img" aria-label="Diagram"></div>
<input id="private" value="SENSITIVE_TYPED_VALUE"><textarea>PRIVATE_TEXTAREA</textarea>
<script>
let n=0;next.onclick=()=>document.querySelector('h1').textContent='Slide '+(++n);
open.onclick=()=>{};document.getElementById('open').onclick=()=>{
 const panel=document.createElement('div');panel.id='overlay';
 panel.innerHTML='<h2>Overlay details</h2><label>Choice Alpha</label><button id="dismiss">Close overlay</button>';
 document.body.append(panel);document.getElementById('dismiss').onclick=()=>panel.remove();
};
</script>`;

async function fixture(t, html = HTML) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-scrape-test-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  // Every request is fulfilled in memory. No LMS/live-browser/network access.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/content/course.html?token=DO_NOT_RECORD#secret`);
  const events = [];
  const recorder = await startRecorder(page, {
    home, emit: (kind, value) => events.push({ kind, value }),
    limits: { pollMs: 20, visualMs: 80 },
  });
  t.after(async () => { recorder.stop('test-cleanup'); await recorder.done; });
  return { home, browser, context, page, events, recorder };
}

test('strict numeric CLI and fail-closed course/URL privacy policy', () => {
  assert.equal(parseArgs(['0']), 0);
  for (const args of [[], ['-1'], ['1x'], ['1', '--all'], ['9007199254740993']]) {
    assert.throws(() => parseArgs(args), /Usage/);
  }
  assert.equal(courseUrl(`${ORIGIN}/content/course.html`, [ORIGIN]), true);
  for (const url of ['http://content-na2prd0004-na2hp.sabacloud.com/content', `${ORIGIN}.evil.test/content`,
    `${ORIGIN}/signin`, `${ORIGIN}/auth/callback`, `${ORIGIN}/account`, 'https://login3.id.hp.com/',
    `https://name:password@content-na2prd0004-na2hp.sabacloud.com/content`]) {
    assert.equal(courseUrl(url, [ORIGIN]), false, url);
  }
  assert.equal(sanitizedUrl(`${ORIGIN}/content/x;token=hidden?password=hidden#hidden`, [ORIGIN]), `${ORIGIN}/content/x`);
  assert.equal(cleanText(`Visit ${ORIGIN}/content?a=SECRET token=SECRET user@example.com`, [ORIGIN]),
    `Visit ${ORIGIN}/content token=[redacted] [email redacted]`);
});

test('real offline browser: rapid clicks, overlays, frame identity and progressive standalone replay', async t => {
  const { page, events, recorder, home } = await fixture(t);
  assert.equal(path.dirname(recorder.folder), path.join(home, 'data', 'quick-scrape'));
  assert.ok(fs.existsSync(path.join(recorder.folder, 'replay.html')));
  const texts = () => events.filter(e => e.kind === 'QUICK_SCRAPE_PAGE').map(e => e.value.text).join('\n');
  // Human-like rapid input is test-only; the recorder itself never acts.
  for (let i = 1; i <= 5; i++) {
    await page.locator('#next').click({ force: true });
    await sleep(45);
  }
  await page.locator('#open').click({ force: true });
  await sleep(70);
  await page.locator('#dismiss').click({ force: true });
  await waitFor(() => texts().includes('Overlay details'), 'overlay transcript');
  for (let i = 0; i <= 5; i++) assert.match(texts(), new RegExp(`Slide ${i}`));
  assert.match(texts(), /Choice Alpha/);
  assert.doesNotMatch(JSON.stringify(events), /SENSITIVE_TYPED_VALUE|PRIVATE_TEXTAREA|DO_NOT_RECORD/);
  const records = fs.readFileSync(path.join(recorder.folder, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(record => record.clicked === 'Next slide'));
  assert.ok(records.every(record => /^frame-\d+$/.test(record.frame)));
  assert.ok(records.every(record => record.text.length <= 5000 && !record.url.includes('?')));
  for (let i = 1; i < records.length; i++) assert.ok(records[i].at >= records[i - 1].at);
  const replay = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(recorder.folder, 'frames.js'), 'utf8'), replay);
  assert.ok(replay.window.quickScrapeFrames.length > 0, 'replay usable before finish');
  for (const frame of replay.window.quickScrapeFrames) {
    const jpeg = fs.readFileSync(path.join(recorder.folder, frame.file));
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
  }
  recorder.stop('finish');
  const result = await recorder.done;
  assert.equal(result.reason, 'finish');
  assert.equal(result.error, null);
  assert.ok(result.pages >= 7);
  assert.equal(events.at(-1).kind, 'QUICK_SCRAPE_RESULT');
  assert.equal(JSON.parse(fs.readFileSync(path.join(recorder.folder, 'result.json'))).reason, 'finish');
  const count = events.length;
  await page.locator('#next').click({ force: true });
  await sleep(150);
  assert.equal(events.length, count, 'stop is genuine');
  assert.equal(page.isClosed(), false, 'selected tab stays open');
});

test('real offline browser: image-only changes create new timestamped JPEGs', async t => {
  const { page, recorder } = await fixture(t);
  const manifest = () => {
    const replay = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(recorder.folder, 'frames.js'), 'utf8'), replay);
    return replay.window.quickScrapeFrames;
  };
  await waitFor(() => manifest().length > 0, 'initial image');
  const initial = manifest().length;
  await page.locator('#art').evaluate(el => { el.style.background = 'lime'; });
  await waitFor(() => manifest().length > initial, 'image-only changed JPEG');
  const entries = manifest();
  assert.notDeepEqual(fs.readFileSync(path.join(recorder.folder, entries[0].file)),
    fs.readFileSync(path.join(recorder.folder, entries.at(-1).file)));
  assert.ok(entries.at(-1).at >= entries[0].at);
  recorder.stop();
  assert.equal((await recorder.done).reason, 'stop');
});

test('real offline browser: unsafe pages excluded, editable values never transcribed, close stops', async t => {
  const { page, events, recorder } = await fixture(t);
  await waitFor(() => events.some(e => e.kind === 'QUICK_SCRAPE_PAGE'), 'initial course observation');
  const count = events.filter(e => e.kind === 'QUICK_SCRAPE_PAGE').length;
  await page.setContent('<title>Sign in</title><h1>Sign in</h1><input type=password value=TOP_SECRET><p>AUTH_PRIVATE_CONTENT</p>');
  await sleep(250);
  assert.equal(events.filter(e => e.kind === 'QUICK_SCRAPE_PAGE').length, count);
  assert.doesNotMatch(JSON.stringify(events), /TOP_SECRET|AUTH_PRIVATE_CONTENT/);
  await page.close();
  const result = await recorder.done;
  assert.equal(result.reason, 'page-closed');
  assert.equal(result.error, null);
});

test('real offline browser: bounded duration and screen chunks', async t => {
  const { page, recorder } = await fixture(t);
  recorder.stop('finish');
  await recorder.done;
  const events = [];
  const second = await startRecorder(page, {
    home: path.dirname(path.dirname(path.dirname(recorder.folder))),
    emit: (kind, value) => events.push({ kind, value }),
    limits: { durationMs: 250, pollMs: 20, visualMs: 100 },
  });
  const result = await second.done;
  assert.equal(result.reason, 'duration-limit');
  assert.ok(result.frames < 10);
  assert.ok(events.some(e => e.kind === 'QUICK_SCRAPE_READY'));
  assert.ok(events.every(e => e.kind !== 'QUICK_SCRAPE_PAGE' || e.value.text.length <= 5000));
});

test('CLI attaches to an isolated local fixture CDP, accepts finish newline, disconnects without closing tab', async t => {
  const { browser, page } = await fixture(t);
  const cdp = await browser.newBrowserCDPSession();
  // Fixture Chromium uses a pipe, so expose an additional loopback-only CDP port.
  // A separate launch is required to test the real CLI attachment path.
  await cdp.detach();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-scrape-cli-'));
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const isolated = await chromium.launch({ channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    await isolated.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const context = await isolated.newContext();
  await context.route('**/*', route => route.fulfill({ body: HTML, contentType: 'text/html' }));
  const tab = await context.newPage();
  await tab.goto(`${ORIGIN}/content/cli.html`);
  child = spawn(process.execPath, [path.join(__dirname, 'pw-quick-scrape.js'), '0'], {
    env: { ...process.env, QUIZTAKER_HOME: home, PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const exit = new Promise(resolve => child.on('exit', code => resolve(code)));
  await waitFor(() => output.includes('QUICK_SCRAPE_READY'), 'CLI ready', 10000);
  child.stdin.write('finish\n');
  assert.equal(await exit, 0, errors);
  const lines = output.trim().split(/\r?\n/);
  const result = JSON.parse(lines.find(line => line.startsWith('QUICK_SCRAPE_RESULT ')).slice('QUICK_SCRAPE_RESULT '.length));
  assert.equal(result.reason, 'finish');
  assert.ok(fs.existsSync(path.join(result.folder, 'replay.html')));
  assert.equal(tab.isClosed(), false);
  assert.equal(page.isClosed(), false);
});
