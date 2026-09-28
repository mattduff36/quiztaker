import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  assertFreshTarget,
  capabilities,
  resolveScriptArgs,
  resultEnvelope,
  sanitizeRecentUrl,
  signJob,
  validateCapabilityInput,
  validateOpenUrl,
  verifyJob,
} from '../dist/index.js';

const target = {
  browserSessionId: '11111111-1111-4111-8111-111111111111',
  revision: 2,
  targetId: '22222222-2222-4222-8222-222222222222',
  fingerprint: 'abcdefabcdefabcdefabcdef',
};

test('rejects quiz executors and unsafe open URLs', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(capabilities.some((item) => item.script.startsWith('pw-quiz-')), false);
  assert.equal(validateOpenUrl('https://user:pass@example.com/path'), null);
  assert.equal(validateOpenUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeRecentUrl('https://example.com/path?token=secret&ok=1#hash'), 'https://example.com/path?ok=1');
  assert.match(validateOpenUrl('https://example.com/path?ok=1#section') || '', /#section$/);
});

test('derives stable signed args and rejects stale targets', () => {
  const validated = validateCapabilityInput('fit-tab', { capabilityId: 'fit-tab', target });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const session = { id: target.browserSessionId, revision: 2, tabs: [{ ...target, index: 3, title: 'Tab', url: 'https://example.com' }] };
  assert.deepEqual(resolveScriptArgs('fit-tab', validated.args, session), ['3']);
  assert.throws(() => resolveScriptArgs('fit-tab', validated.args, { ...session, revision: 1 }), /stale/);
  assert.throws(() => resolveScriptArgs('fit-tab', validated.args, {
    ...session,
    tabs: [session.tabs[0], { ...session.tabs[0], index: 4 }],
  }), /stale/);
  assert.throws(() => assertFreshTarget({ target }, { ...session, revision: 9 }), /stale/);
});

test('requires selected roster titles and ignores empty input objects', () => {
  const missing = validateCapabilityInput('cert-batch', { capabilityId: 'cert-batch' });
  assert.equal(missing.ok, false);
  const selected = validateCapabilityInput('cert-batch', { capabilityId: 'cert-batch', titles: ['Course A'] });
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.deepEqual(selected.args, ['--only=Course A']);

  const secret = 'test-secret';
  const envelope = signJob({
    jobId: 'b4e08cdd-5bd8-4981-a4ae-cf7f699aa37d',
    planId: '488fa8b8-82f5-45df-890f-67c24f525675',
    attemptId: '552b4776-3c91-4fc9-bee4-1b0bc2170fe0',
    helperId: '9c60d37a-a023-475a-af4f-a89a81903e47',
    capabilityId: 'list-tabs',
    capabilityVersion: 1,
    script: 'pw-list-tabs.js',
    args: [],
    fingerprint: null,
    nonce: 'dfb21119-f1b6-4dd3-aeb7-3c02cbff1d9a',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    input: {},
  }, secret);
  assert.equal(verifyJob(envelope, secret), true);
  const result = resultEnvelope('list-tabs', true, { tabs: 1 });
  assert.equal(result.schemaVersion, 1);
});
