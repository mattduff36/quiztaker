import assert from 'node:assert/strict';
import test from 'node:test';
import { browserConnectionLost } from '../src/lib/browser-connection';

test('CDP refusal invalidates an old connected snapshot', () => {
  assert.equal(browserConnectionLost('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222\nCall log:', 'list-tabs'), true);
  assert.equal(browserConnectionLost('browserType.connectOverCDP: WebSocket closed unexpectedly', 'detect'), true);
});
test('explicit failed connection checks work even without a browser session in their result', () => {
  assert.equal(browserConnectionLost('', 'cdp-check', { result: { connected: false } }), true);
  assert.equal(browserConnectionLost('', 'start-browser', { connected: false }), true);
  assert.equal(browserConnectionLost('', 'start-browser', { connected: true }), false);
});
test('course errors and unrelated connection text do not disconnect a live browser', () => {
  assert.equal(browserConnectionLost('page.goto: net::ERR_CONNECTION_REFUSED', 'open-url'), false);
  assert.equal(browserConnectionLost('Course server ECONNREFUSED', 'detect'), false);
  assert.equal(browserConnectionLost('', 'quiz-learn', { result: { connected: false } }), false);
});
