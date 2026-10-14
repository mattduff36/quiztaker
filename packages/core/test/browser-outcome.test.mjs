import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOutcome } from '../dist/index.js';

test('packaged browser start is verified from its connection result', () => {
  const outcome = classifyOutcome({ script: 'start-cdp-browser.js', code: 0, output: '{"connected":true,"pid":123}' });
  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.verified, true);
  assert.equal(outcome.status, 'browser-connected');
});

test('browser start requires a positive boolean connection result and successful exit', () => {
  for (const output of ['', '{}', 'not JSON', '{"connected":false}', '{"connected":"true"}']) {
    assert.equal(classifyOutcome({ script: 'start-cdp-browser.js', code: 0, output }).verified, false, output);
  }
  assert.equal(classifyOutcome({ script: 'start-cdp-browser.js', code: 1, output: '{"connected":true}' }).verified, false);
  assert.equal(classifyOutcome({ script: 'pw-scorm-complete.js', code: 0, output: '{"connected":true}' }).verified, false);
});

test('tab inspection verifies written text evidence without claiming a quiz passed', () => {
  const good = JSON.stringify({ ok: true, text: 'data/prep/tab2.txt', bytes: 1593 });
  assert.equal(classifyOutcome({ script: 'pw-tab-inspect.js', code: 0, output: good }).status, 'inspection-written');
  assert.equal(classifyOutcome({ script: 'pw-tab-inspect.js', code: 0, output: good }).verified, true);
  for (const output of ['{}', 'not JSON', '{"ok":true}', '{"ok":true,"text":"x","bytes":0}']) {
    assert.equal(classifyOutcome({ script: 'pw-tab-inspect.js', code: 0, output }).verified, false);
  }
  assert.equal(classifyOutcome({ script: 'pw-tab-inspect.js', code: 1, output: good }).verified, false);
  assert.equal(classifyOutcome({ script: 'pw-scorm-complete.js', code: 0, output: good }).verified, false);
});

test('learner questions pause without claiming completion or failure', () => {
  const result = 'AUTOMATION_RESULT ' + JSON.stringify({completed:0,total:1,failures:[{title:'Learning',reason:'needs-user-input'}]});
  const output = 'LEARNER_QUESTION {"question":"Which module?"}\n' + result;
  const outcome = classifyOutcome({script:'pw-learn-quiz.js',code:1,output});
  assert.equal(outcome.status, 'needs-user-input');
  assert.equal(outcome.outcome, 'partial');
  assert.equal(outcome.verified, false);
  for (const invalid of [result, 'LEARNER_QUESTION {"question":""}\n' + result]) {
    assert.equal(classifyOutcome({script:'pw-learn-quiz.js',code:1,output:invalid}).outcome, 'failure');
  }
  assert.equal(classifyOutcome({script:'pw-scorm-complete.js',code:1,output}).outcome, 'failure');
});
