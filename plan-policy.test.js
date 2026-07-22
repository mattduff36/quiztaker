const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeRun } = require('./lib/plan-policy');

test('rejects mutating run without confirmation', () => {
  const result = authorizeRun({
    script: 'pw-scorm-complete.js',
    args: ['0'],
    plan: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('rejects a run that differs from confirmed plan', () => {
  const result = authorizeRun({
    script: 'pw-scorm-complete.js',
    args: ['1'],
    plan: {
      confirmed: true,
      consumed: false,
      script: 'pw-scorm-complete.js',
      args: ['0'],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('accepts exact confirmed mutation and read-only dry run', () => {
  const confirmed = authorizeRun({
    script: 'pw-scorm-complete.js',
    args: ['0'],
    plan: {
      confirmed: true,
      consumed: false,
      script: 'pw-scorm-complete.js',
      args: ['0'],
    },
  });
  assert.equal(confirmed.ok, true);

  const dry = authorizeRun({
    script: 'pw-cert-batch.js',
    args: ['--dry'],
  });
  assert.equal(dry.ok, true);
});
