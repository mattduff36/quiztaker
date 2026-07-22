const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-ledger-test-'));
process.env.SABA_ATTEMPT_DIR = tempRoot;

const {
  appendEvent,
  createAttempt,
  finishAttempt,
  readAttempts,
  recordConfirmation,
  recordStep,
} = require('./lib/attempt-ledger');

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('reconstructs a versioned attempt from append-only events', () => {
  const attemptId = createAttempt({
    source: 'test',
    capabilityId: 'fixture',
    capabilityVersion: 2,
    fingerprint: 'abc',
  });
  recordConfirmation(attemptId, true);
  recordStep(attemptId, 'fixture-step', { ok: true });
  finishAttempt(attemptId, 'success', { verified: true, status: 'passed' });
  appendEvent(attemptId, 'attempt-diagnosed', {
    failureSignature: 'fixture-diagnosis',
    diagnosis: { likelyCause: { label: 'Fixture diagnosis' } },
  });

  const attempt = readAttempts().find((row) => row.attemptId === attemptId);
  assert.equal(attempt.schemaVersion, 1);
  assert.equal(attempt.capabilityId, 'fixture');
  assert.equal(attempt.outcome, 'success');
  assert.equal(attempt.verified, true);
  assert.equal(attempt.diagnosis.likelyCause.label, 'Fixture diagnosis');
  assert.equal(attempt.events.length, 5);
});
