const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOutcome } = require('./lib/outcome');

test('recognizes verified SCORM completion', () => {
  const result = classifyOutcome({
    script: 'pw-scorm-complete.js',
    code: 0,
    output: '{"completion":"completed","success":"passed","commit":"true"}',
  });
  assert.deepEqual(
    { outcome: result.outcome, verified: result.verified, status: result.status },
    { outcome: 'success', verified: true, status: 'passed' },
  );
});

test('recognizes complete batch and failure signature', () => {
  assert.equal(classifyOutcome({
    script: 'pw-container-batch.js',
    code: 0,
    output: '3/3 confirmed complete',
  }).verified, true);

  const failure = classifyOutcome({
    script: 'pw-container-batch.js',
    code: 1,
    output: 'SCORM API not found',
  });
  assert.equal(failure.outcome, 'failure');
  assert.equal(failure.failureSignature, 'scorm api not found');
});

test('recognizes a verified quiz-learn pass and rejects a partial result', () => {
  const passed = classifyOutcome({
    script: 'pw-learn-quiz.js',
    code: 0,
    output: 'AUTOMATION_RESULT {"completed":1,"total":1}',
  });
  assert.equal(passed.outcome, 'success');
  assert.equal(passed.verified, true);
  assert.equal(passed.status, '1/1 completed');

  const stopped = classifyOutcome({
    script: 'pw-learn-quiz.js',
    code: 1,
    output: 'AUTOMATION_RESULT {"completed":0,"total":1,"failures":[{"title":"quiz-learn","reason":"rejected-action"}]}',
  });
  assert.equal(stopped.outcome, 'failure');
  assert.equal(stopped.verified, false);
});

test('recognizes partial structured batch and linked artifacts', () => {
  const output = `AUTOMATION_RESULT ${JSON.stringify({
    schemaVersion: 1,
    kind: 'cert-batch',
    completed: 0,
    total: 1,
    failures: [{
      title: 'Blocked course',
      reason: 'prerequisites-incomplete',
      artifact: 'data/course-history/evidence.png',
    }],
  })}`;
  const result = classifyOutcome({
    script: 'pw-cert-batch.js',
    code: 0,
    output,
  });
  assert.equal(result.outcome, 'failure');
  assert.equal(result.failureSignature, 'prerequisites-incomplete');
  assert.deepEqual(result.artifacts, ['data/course-history/evidence.png']);
});
