import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceIndicators, servicePollDelay, type ServiceStatusSnapshot } from '../src/lib/service-status.js';

const now = Date.parse('2026-11-03T18:00:00Z');
const at = (age: number) => new Date(now - age).toISOString();
const snapshot: ServiceStatusSnapshot = { checkedAt: at(0), helper: { online: true, lastSeenAt: at(10_000) }, browser: { connected: true, checkedAt: at(30_000) }, assistant: { ready: true, source: 'personal', provider: 'openai' } };

test('fresh service evidence reports browser connection separately from assistant configuration', () => {
  const result = serviceIndicators({ snapshot, now });
  assert.deepEqual(result.map(item => item.state), ['Online', 'Connected', 'Connected', 'Configured']);
  assert.match(result[3].detail, /configuration.*availability is checked when a task runs/);
  assert.equal(result[3].href, '/settings');
});

test('missing, old, disconnected and failed evidence never preserve a green browser', () => {
  for (const browser of [null, { connected: true, checkedAt: at(91_000) }, { connected: false, checkedAt: at(0) }]) {
    assert.notEqual(serviceIndicators({ snapshot: { ...snapshot, browser }, now })[2].tone, 'good');
  }
  for (const helper of [null, { online: false, lastSeenAt: at(0) }, { online: true, lastSeenAt: at(46_000) }]) {
    assert.notEqual(serviceIndicators({ snapshot: { ...snapshot, helper }, now })[2].tone, 'good');
  }
  for (const input of [{ snapshot, now, failed: true }, { snapshot, now, offline: true }, { snapshot: { ...snapshot, checkedAt: at(46_000) }, now }, { snapshot: null, now }]) {
    assert.ok(serviceIndicators(input).every(item => item.tone !== 'good'));
  }
});

test('unpaired helper and disabled or unconfigured assistant offer setup without inventing connectivity', () => {
  const result = serviceIndicators({ snapshot: { ...snapshot, helper: null, assistant: { ready: false, source: 'none', provider: null } }, now });
  assert.equal(result[1].state, 'Not paired'); assert.equal(result[2].state, 'Unknown'); assert.equal(result[3].state, 'Set up');
  assert.equal(serviceIndicators({ snapshot: { ...snapshot, assistant: { ready: false, source: 'disabled', provider: null } }, now })[3].state, 'Disabled');
  assert.equal(serviceIndicators({ snapshot: { ...snapshot, browser: { connected: true, checkedAt: 'invalid' } }, now })[2].state, 'Check overdue');
});

test('status refresh backs off and hidden pages do not poll faster', () => {
  assert.equal(servicePollDelay(true, 0), 20_000);
  assert.equal(servicePollDelay(true, 1), 40_000);
  assert.equal(servicePollDelay(true, 9), 60_000);
  assert.equal(servicePollDelay(false, 0), 60_000);
});
