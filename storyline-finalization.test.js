const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { createStorylineFinalizer, existingCompletion, returnedCourseEvidence } = require('./lib/storyline-finalization');
const { activateCourseExit, localActionAllowed } = require('./pw-learn-quiz');

const host = 'https://hpi-external.sabacloud.com';
const content = 'https://content-na2prd0004-na2hp.sabacloud.com';
const address = `${host}/Saba/Web_spf/HPI/app/content-player?contextid=coursfixture&regid=regfixture&backurl=me%2Fledetail%2Fcrtfyfixture`;
const apiPath = '/content/rcs/scorm_frame.html';

async function fixture(browser, options = {}) {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    let html;
    if (url.origin === content && (url.pathname === apiPath || (options.nested && url.pathname === '/content/rcs/remote_frameset_modern.html'))) {
      html = `<script>
        window.calls=[];window.status=${JSON.stringify(options.status || 'completed')};
        window.API={
          LMSGetValue(key){calls.push(['get',key]);return status},
          LMSGetLastError(){return '0'},
          LMSCommit(){calls.push(['commit']);return ${JSON.stringify(options.commit === false ? 'false' : 'true')}},
          LMSSetValue(){throw Error('Synthetic completion is forbidden')},
          LMSInitialize(){throw Error('Initialization is forbidden')},
          LMSFinish(){throw Error('Programmatic termination is forbidden')}
        };
      </script>${options.nested && url.pathname !== apiPath ? `<iframe name="sco" src="${content}/course/index_lms.html"></iframe><iframe name="scorm_api" src="${content}${apiPath}"></iframe><script>addEventListener("message",e=>{if(e.data==="module-close")parent.postMessage(e.data,"${host}")})</script>` : ""}`;
    } else if (url.origin === content && url.pathname === '/course/index_lms.html') {
      html = `<div id="slide-label">slide: ${options.early ? 'Overview' : options.results ? 'Results Slide' : 'Thank You'}</div>
        <div class="slide-layer base-layer shown"></div><div class="slide-layer shown">${options.results
          ? '<p>Your score: 80%</p><p>Passing Score: 70%</p><p>Passed</p>'
          : 'Congratulations! You have now completed this module.'}
          <button onclick="parent.postMessage('module-close','${host}')">Close module</button>
          ${options.duplicate ? '<button>Close module</button>' : ''}
        </div>`;
    } else if (url.origin === host && url.pathname.endsWith('/content-player')) {
      html = `<title>MyKnowledge App</title><h1>MyKnowledge App</h1>
        <div class="activity-list-item" role="button" id="activity">
          <span class="activity-cont activity-title" title="0001113683_20250729_MyKnowledge App">MyKnow...</span>
          <span id="state" title="In Progress"></span>
        </div>
        <button id="close" onclick="window.wrapperCloses=(window.wrapperCloses||0)+1;document.getElementById('dialog').hidden=false">CLOSE PLAYER</button>
        <div role="dialog" id="dialog" hidden>
          <p>${options.unsafe || 'Do you want to close this course player?'}</p>
          <button onclick="window.confirmations=(window.confirmations||0)+1;location.href='${host}/Saba/Web_spf/HPI/app/me/ledetail/crtfyfixture'">YES</button><button>NO</button>
        </div>
        ${options.nested ? `<iframe src="${content}/content/rcs/remote_frameset_modern.html"></iframe>` : `<iframe name="sco" src="${content}/course/index_lms.html"></iframe><iframe name="scorm_api" src="${content}${apiPath}"></iframe>`}
        <script>
          addEventListener('message',e=>{if(e.origin==='${content}'&&e.data==='module-close'){
            window.moduleCloses=(window.moduleCloses||0)+1;
            ${options.directReturn ? `location.href="${host}/Saba/Web_spf/HPI/app/me/ledetail/crtfyfixture";` : options.activityUnverified ? '' : "document.getElementById('state').title='Completed Successfully';"}
          }});
        </script>`;
    } else if (url.origin === host && url.pathname.endsWith('/ledetail/crtfyfixture')) {
      html = `<h1>Certification</h1>${options.parentUnverified ? '<p>In Progress</p>' : '<button title="Print certificate for WBT MyKnowledge App">Print certificate</button>'}`;
    } else {
      html = '<title>Unrelated landing</title><h1>Successful</h1><button onclick="window.clicked=true">YES</button>';
    }
    await route.fulfill({ contentType: 'text/html', body: html });
  });
  const unrelated = await context.newPage();
  await unrelated.goto(`${host}/unrelated`);
  const page = await context.newPage();
  await page.goto(address);
  await page.frame({ name: 'sco' }).locator('button').first().waitFor();
  const api = options.nested ? page.frames().find(frame => frame.url().includes('/remote_frameset_modern.html')) : page.frame({ name: 'scorm_api' });
  await api.waitForFunction(() => Boolean(window.API));
  return { context, page, api, unrelated, finalize: createStorylineFinalizer(page, activateCourseExit, { timeoutMs: 450 }) };
}

test('terminal direct wrapper commits only genuine completion and verifies the matching LMS return', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { context, page, unrelated, finalize } = await fixture(browser, { nested: true, activityUnverified: true, directReturn: true });
    const result = await finalize();
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.ok(result.evidence.some(text => text.includes('Print certificate')));
    assert.match(page.url(), /\/ledetail\/crtfyfixture$/);
    assert.equal(unrelated.isClosed(), false);
    assert.equal(await unrelated.evaluate(() => window.clicked), undefined);
    assert.equal(context.pages().length, 2);
  } finally { await browser.close(); }
});

test('Thank You, failed commits and incomplete LMS evidence never report a pass', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [options, reason] of [
      [{ status: 'incomplete' }, 'scorm-completion-not-recorded'],
      [{ commit: false }, 'scorm-commit-failed'],
      [{ activityUnverified: true, parentUnverified: true }, 'parent-course-success-unverified'],
      [{ parentUnverified: true }, 'parent-course-success-unverified'],
    ]) {
      const { context, page, finalize } = await fixture(browser, options);
      const result = await finalize();
      assert.equal(result.verified, undefined);
      assert.equal(result.reason, reason);
      if (options.commit === false) assert.equal(await page.evaluate(() => window.moduleCloses), undefined);
      if (options.status) assert.equal(await page.evaluate(() => window.wrapperCloses), undefined);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('early, changed-target, ambiguous and unsafe exits stay scoped and fail closed', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const early = await fixture(browser, { early: true });
    assert.deepEqual(await early.finalize(), { attempted: false });
    assert.equal(await early.page.evaluate(() => window.moduleCloses), undefined);
    await early.page.goto(address.replace('regfixture', 'regother'));
    assert.deepEqual(await early.finalize(), { attempted: false });
    await early.page.goto(`${host}/Saba/Web_spf/HPI/app/me/ledetail/crtfyfixtureother`);
    assert.equal(await returnedCourseEvidence(early.page, address, 'MyKnowledge App'), null);
    await early.context.close();
    const duplicate = await fixture(browser, { duplicate: true });
    assert.equal((await duplicate.finalize()).reason, 'ambiguous-module-exit');
    assert.equal(await duplicate.page.evaluate(() => window.moduleCloses), undefined);
    await duplicate.context.close();
    for (const message of ['Delete account and close this course player?', 'Close this course and the browser?',
      'Exit this course and confirm payment?', 'Close this course and withdraw enrollment?',
      'Close this course and charge your credit card?', 'Exit this course and discard unsaved changes?']) {
      const unsafe = await fixture(browser, { unsafe: message });
      assert.equal((await unsafe.finalize()).reason, 'unsafe-course-exit-confirmation', message);
      assert.equal(await unsafe.page.evaluate(() => window.confirmations), undefined);
      assert.equal(await unsafe.unrelated.evaluate(() => window.clicked), undefined);
      await unsafe.context.close();
    }
  } finally { await browser.close(); }
  for (const name of ['Close module', 'CLOSE PLAYER', 'Exit course', 'Close browser', 'Delete account']) {
    assert.equal(localActionAllowed({ action: 'click', targetId: 'b1' }, { buttons: [{ id: 'b1', name }] }, 'quiz'), false);
  }
});

test('a real quiz result remains separate from unverified parent course completion', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { finalize } = await fixture(browser, { results: true, parentUnverified: true });
    const result = await finalize();
    assert.equal(result.verified, undefined);
    assert.equal(result.reason, 'parent-course-success-unverified');
    assert.equal(result.quizResult?.status, 'passed');
    assert.equal(result.quizResult?.scorePercent, 80);
  } finally { await browser.close(); }
});

test('SCORM 2004 commits existing genuine completion only; failed/incomplete state is never changed', async () => {
  for (const [completion, success, committed] of [
    ['completed', 'passed', true], ['completed', 'unknown', true], ['completed', 'failed', false], ['incomplete', 'passed', false],
  ]) {
    const calls = [];
    const api = {
      GetValue: key => key === 'cmi.completion_status' ? completion : success,
      GetLastError: () => '0',
      Commit: () => { calls.push('commit'); return 'true'; },
    };
    const frame = { evaluate: (fn, arg) => require('node:vm').runInNewContext(`(${fn})(${JSON.stringify(arg)})`, { window: { API_1484_11: api } }) };
    const result = await existingCompletion(frame, true);
    assert.equal(result.committed === true, committed);
    assert.equal(calls.length, committed ? 1 : 0);
  }
});

async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('learner process finalizes the direct wrapper locally before asking a model or inventing quiz success', { timeout: 30_000 }, async () => {
  for (const status of ['completed', 'incomplete']) {
    const port = await unusedPort();
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
    const home = mkdtempSync(join(tmpdir(), 'vitriol-storyline-'));
    try {
      const { page } = await fixture(browser, { status });
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['pw-learn-quiz.js', '0'], {
          cwd: __dirname, env: { ...process.env, PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${port}`,
            VITRIOL_CAPTURE_TARGET: page.url(), QUIZTAKER_HOME: home, VITRIOL_LEARNER_MODE: 'quiz',
            SABA_QUIZ_TYPES_FILE: join(home, 'QUIZ-TYPES.md'),
            VITRIOL_COORDINATE: '', VITRIOL_LEARNER_CONVERSATION: '', VITRIOL_LEARNER_GUIDANCE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', data => output += data);
        child.stderr.on('data', data => output += data);
        child.once('error', reject);
        child.once('close', code => resolve({ code, output }));
      });
      assert.equal(result.code, status === 'completed' ? 0 : 1, result.output);
      const automation = JSON.parse(result.output.match(/^AUTOMATION_RESULT (.+)$/m)?.[1] || '{}');
      assert.equal(automation.completed, status === 'completed' ? 1 : 0, result.output);
      assert.equal(automation.courseResult?.status, status === 'completed' ? 'completed' : 'unverified', result.output);
      assert.equal(automation.quizResult, undefined);
      if (status === 'completed') assert.doesNotMatch(result.output, /LEARNER_QUESTION|LEARNER_SCREENSHOT/);
      else assert.match(result.output, /LEARNER_QUESTION.*not verified/);
    } finally {
      await browser.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
