import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionState, isWebUrl, operationNeedsBrowser, readJsonResponse } from '../src/lib/operations-readiness.js';

test('browser recovery can be confirmed before a browser connection exists', () => {
  for (const capability of ['start-browser', 'cdp-check', 'list-tabs']) assert.equal(operationNeedsBrowser(capability), false);
  for (const capability of ['open-url', 'close-browser', 'tab-inspect', 'detect']) assert.equal(operationNeedsBrowser(capability), true);
});

test('connection status distinguishes absent browser evidence from a disconnected snapshot', () => {
  assert.equal(connectionState(null, false), 'loading');
  assert.equal(connectionState(null, true), 'unavailable');
  assert.equal(connectionState({ helper: null }, false), 'helper-offline');
  assert.equal(connectionState({ helper: { is_online: false }, session: { cdp_connected: true } }, false), 'helper-offline');
  assert.equal(connectionState({ helper: { is_online: true }, session: null }, false), 'browser-unknown');
  assert.equal(connectionState({ helper: { is_online: true }, session: {} }, false), 'browser-unknown');
  assert.equal(connectionState({ helper: { is_online: true }, session: { cdp_connected: false } }, false), 'browser-offline');
  assert.equal(connectionState({ helper: { is_online: true }, session: { cdp_connected: true } }, false), 'connected');
});

test('failed context refresh overrides an older connected snapshot', () => {
  assert.equal(connectionState({ helper: { is_online: true }, session: { cdp_connected: true } }, true), 'unavailable');
});

test('URL navigation accepts only nonempty absolute HTTP and HTTPS URLs', () => {
  for (const url of ['', ' ', 'example.com', 'javascript:alert(1)', 'file:///C:/test', 'ftp://example.com']) assert.equal(isWebUrl(url), false, url);
  for (const url of ['https://example.com/path', 'http://localhost:4000', ' https://example.com ']) assert.equal(isWebUrl(url), true, url);
});

test('response handling retains API errors and explains unreadable or empty responses', async () => {
  await assert.rejects(readJsonResponse(new Response('{"error":"Helper offline"}', { status: 409 }), 'Could not queue.'), /Helper offline/);
  await assert.rejects(readJsonResponse(new Response('<html>Unavailable</html>', { status: 502 }), 'Could not queue.'), /unreadable response.*Retry/);
  await assert.rejects(readJsonResponse(new Response('null'), 'Could not queue.'), /empty response.*Retry/);
  assert.deepEqual(await readJsonResponse(new Response('{"jobId":"123"}'), 'Could not queue.'), { jobId: '123' });
});
