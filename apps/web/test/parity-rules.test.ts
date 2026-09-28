import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityNegotiationError } from '../src/lib/capability-negotiation.js';
import { nextStrategyState } from '../src/lib/strategy-state.js';

test('protocol 1 helpers keep legacy cards and reject new actions', () => {
  assert.equal(capabilityNegotiationError({
    protocolVersion: 1, supported: [], capabilityId: 'list-tabs', capabilityVersion: 1,
  }), null);
  assert.match(capabilityNegotiationError({
    protocolVersion: 1, supported: [], capabilityId: 'detect', capabilityVersion: 2,
  }) || '', /Update the Windows helper/);
});

test('protocol 2 helpers must advertise the capability version', () => {
  assert.equal(capabilityNegotiationError({
    protocolVersion: 2,
    supported: [{ id: 'detect', version: 2 }],
    capabilityId: 'detect',
    capabilityVersion: 2,
  }), null);
  assert.match(capabilityNegotiationError({
    protocolVersion: 2, supported: [], capabilityId: 'list-tabs', capabilityVersion: 1,
  }) || '', /does not support/);
});

test('strategy evidence deduplicates attempts and demotes a promoted regression', () => {
  const first = nextStrategyState(null, { attemptId: 'a', verified: true, targets: ['one'], at: '2026-09-28T00:00:00.000Z' });
  const repeat = nextStrategyState(first, { attemptId: 'a', verified: true, targets: ['one'], at: '2026-09-28T00:01:00.000Z' });
  assert.equal(repeat.successes, 1);
  const second = nextStrategyState(repeat, { attemptId: 'b', verified: true, targets: ['two'], at: '2026-09-28T00:02:00.000Z' });
  const third = nextStrategyState(second, { attemptId: 'c', verified: true, targets: ['two'], at: '2026-09-28T00:03:00.000Z' });
  assert.equal(third.status, 'promoted');
  const demoted = nextStrategyState(third, { attemptId: 'd', verified: false, targets: [], at: '2026-09-28T00:04:00.000Z' });
  assert.equal(demoted.demoted, true);
  assert.equal(demoted.status, 'needs-review');
  const replay = nextStrategyState(demoted, { attemptId: 'd', verified: false, targets: [], at: '2026-09-28T00:05:00.000Z' });
  assert.equal(replay.failures, demoted.failures);
  let singleTarget = nextStrategyState(null, { attemptId: 's1', verified: true, targets: ['only'], at: '2026-09-28T01:00:00.000Z' });
  singleTarget = nextStrategyState(singleTarget, { attemptId: 'fail', verified: false, targets: ['other'], at: '2026-09-28T01:01:00.000Z' });
  singleTarget = nextStrategyState(singleTarget, { attemptId: 's2', verified: true, targets: ['only'], at: '2026-09-28T01:02:00.000Z' });
  singleTarget = nextStrategyState(singleTarget, { attemptId: 's3', verified: true, targets: ['only'], at: '2026-09-28T01:03:00.000Z' });
  assert.deepEqual(singleTarget.targets, ['only']);
  assert.equal(singleTarget.status, 'candidate');
});

