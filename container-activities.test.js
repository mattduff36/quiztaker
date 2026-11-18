const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readActivities, clickActivity, containerResult } = require('./lib/container-activities');
const { diagnoseRun } = require('./lib/run-diagnosis');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');

test('container activation uses the exact observed title, never truncated text or a substring', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="button" class="activity-list-item" id="target" onclick="window.clicked=this.id">
        <span class="activity-cont activity-title" title="MyKnowledge App">MyKnow...</span>
      </div>
      <div role="button" class="activity-list-item" id="decoy" onclick="window.clicked=this.id">
        <span class="activity-cont activity-title" title="MyKnowledge App extra">MyKnowledge App</span>
      </div>`);
    const [activity] = await readActivities(page);
    assert.equal(activity.title, 'MyKnowledge App');
    assert.equal(await clickActivity(page, activity, 0), 'clicked');
    assert.equal(await page.evaluate(() => window.clicked), 'target');
    assert.equal(await clickActivity(page, 'MyKnowledge', 0), 'not-found');
    await page.evaluate(() => document.getElementById('target').id = 'replacement');
    assert.equal(await clickActivity(page, activity, 0), 'target-changed');
    await page.evaluate(() => document.querySelector('#decoy span').title = 'MyKnowledge App');
    assert.equal(await clickActivity(page, 'MyKnowledge App', 0), 'ambiguous');
    assert.equal(await page.evaluate(() => window.clicked), 'target');
  } finally { await browser.close(); }
});

test('container results never turn missing/ambiguous activities or an unverified parent into success', () => {
  const activity = { title: 'MyKnowledge App', status: 'In Progress' };
  for (const reason of ['activity-not-found', 'activity-ambiguous']) {
    const result = containerResult([activity], [activity], [{ title: activity.title, ok: false, reason }], false);
    assert.equal(result.completed, 0);
    assert.equal(result.total, 2);
    assert.ok(result.failures.some(failure => failure.reason === reason));
    const diagnosis = diagnoseRun({ script: 'pw-container-batch.js', code: 1, output: `AUTOMATION_RESULT ${JSON.stringify(result)}` });
    assert.ok(diagnosis);
    assert.equal(diagnosis.completed, 0);
  }
  const done = [{ ...activity, status: 'Completed' }];
  assert.deepEqual(containerResult([activity], done, [], true), { completed: 2, total: 2, failures: [] });
  const partial = containerResult([activity], done, [], false);
  assert.equal(partial.completed, 1);
  assert.ok(partial.failures.some(failure => failure.reason === 'parent-course-success-unverified'));
  assert.equal(containerResult([], [], [], false).completed, 0);
  assert.ok(containerResult([], [], [], false).total > 0);
});

test('the actual container executor reports duplicate targets as structured failure and exits nonzero', { timeout: 30_000 }, async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
  const home = mkdtempSync(join(tmpdir(), 'vitriol-container-'));
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
      body: `<title>MyKnowledge App</title>${[1, 2].map(id => `<div class="activity-list-item" role="button" id="activity${id}" onclick="window.clicked=true"><span class="activity-cont activity-title" title="MyKnowledge App">Truncated...</span></div>`).join('')}` }));
    const page = await context.newPage();
    await page.goto('https://hpi-external.sabacloud.com/Saba/Web_spf/HPI/app/content-player?contextid=fixture&regid=registration');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['pw-container-batch.js', '0'], {
        cwd: __dirname, env: { ...process.env, PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${port}`,
          VITRIOL_CAPTURE_TARGET: page.url(), QUIZTAKER_HOME: home, SABA_ATTEMPT_ID: '',
          SABA_QUIZ_TYPES_FILE: join(home, 'QUIZ-TYPES.md') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => output += data);
      child.stderr.on('data', data => output += data);
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1, result.output);
    const automation = JSON.parse(result.output.match(/^AUTOMATION_RESULT (.+)$/m)?.[1] || '{}');
    assert.equal(automation.completed, 0, result.output);
    assert.equal(automation.total, 3);
    assert.ok(automation.failures.some(failure => failure.reason === 'activity-ambiguous'));
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  } finally {
    await browser.close();
    rmSync(home, { recursive: true, force: true });
  }
});
