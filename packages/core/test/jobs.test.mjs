import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOutcome, deriveHelperSecret, signJob, verifyJob } from '../dist/index.js';

function payload(overrides = {}) {
  return {
    jobId: '3858f4ea-1753-4e79-8d0b-d2a4fddaa145',
    planId: '313033f1-d3a9-47b7-b0b2-f54c71ecf6fc',
    attemptId: 'fe15d640-7f99-4dd6-adf0-8201fbd5af48',
    helperId: '0418d0e8-f308-4786-8bce-429b4e1d7fd3',
    capabilityId: 'list-tabs',
    capabilityVersion: 1,
    script: 'pw-list-tabs.js',
    args: [],
    fingerprint: null,
    nonce: '82987ad2-2e9d-46a3-8b13-daaf7c33429b',
    issuedAt: '2026-07-22T10:00:00.000Z',
    expiresAt: '2026-07-22T10:05:00.000Z',
    ...overrides,
  };
}

test('derives a stable per-helper secret', () => {
  const first = deriveHelperSecret('a'.repeat(32), 'helper-a');
  assert.equal(first, deriveHelperSecret('a'.repeat(32), 'helper-a'));
  assert.notEqual(first, deriveHelperSecret('a'.repeat(32), 'helper-b'));
});

test('accepts a signed, unexpired, whitelisted job', () => {
  const secret = deriveHelperSecret('b'.repeat(32), payload().helperId);
  const envelope = signJob(payload(), secret);
  assert.equal(verifyJob(envelope, secret, new Date('2026-07-22T10:01:00.000Z')), true);
});

test('rejects tampering, expiry, and unknown capabilities', () => {
  const secret = deriveHelperSecret('c'.repeat(32), payload().helperId);
  const envelope = signJob(payload(), secret);
  assert.equal(verifyJob({ ...envelope, payload: { ...envelope.payload, args: ['tampered'] } }, secret, new Date('2026-07-22T10:01:00.000Z')), false);
  assert.equal(verifyJob(envelope, secret, new Date('2026-07-22T10:06:00.000Z')), false);
  const unknown = signJob(payload({ capabilityId: 'unknown' }), secret);
  assert.equal(verifyJob(unknown, secret, new Date('2026-07-22T10:01:00.000Z')), false);
});

test('verifies process-exit capabilities without inventing mutating success', () => {
  assert.deepEqual(classifyOutcome({ script: 'pw-list-tabs.js', code: 0, output: 'tabs' }), {
    outcome: 'success',
    verified: true,
    status: 'process-exit-0',
    artifacts: [],
  });
  assert.equal(classifyOutcome({ script: 'pw-scorm-complete.js', code: 0, output: '' }).verified, false);
});
