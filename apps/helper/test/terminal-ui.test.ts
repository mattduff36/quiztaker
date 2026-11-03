import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelperTerminal, responseLogPayload, sanitizeLogText, sanitizeLogValue } from '../src/terminal-ui.js';

test('redacts credentials, embedded JSON, query strings and binary while retaining ordinary course text', () => {
  const raw = { authorization: 'Bearer device-private', apiKey: 'private-api', encryptedDeviceSecret: 'private-dpapi', signature: 'private-signature', nonce: 'private-nonce', cookie: 'session=private-cookie', url: 'https://example.invalid/course?user_cookie=private-session#secret', screenshot: 'private-image', text: 'Paper thickness is calliper.' };
  const safe = JSON.stringify(sanitizeLogValue(raw));
  assert.doesNotMatch(safe, /private-/);
  assert.match(safe, /Paper thickness is calliper/);
  assert.match(safe, /https:\/\/example.invalid\/course/);
  const embedded = sanitizeLogText('LEARNER_SNAPSHOT {\\"apiKey\\":\\"private-key\\", "url":"https://example.invalid/course?qs=private-session"} Bearer private-bearer');
  assert.doesNotMatch(embedded, /private-|qs=/);
  assert.equal(sanitizeLogText('GET /lms/player?qs=private-session'), 'GET /lms/player');
  assert.doesNotMatch(sanitizeLogText('Cookie: sid=private-one; another=private-two'), /private-/);
  assert.match(String(sanitizeLogValue('a'.repeat(5000))), /binary-like payload omitted/);
  assert.doesNotMatch(sanitizeLogText('\x1b[31mhello'), /\x1b/);
});

test('response previews leave the caller body readable and omit binary content', async () => {
  const response = new Response(JSON.stringify({ action: 'scroll', token: 'private-token' }), { headers: { 'content-type': 'application/json' } });
  const preview = await responseLogPayload(response);
  assert.doesNotMatch(JSON.stringify(preview), /private-token/);
  assert.deepEqual(await response.json(), { action: 'scroll', token: 'private-token' });
  const binary = await responseLogPayload(new Response(Buffer.from('private-image'), { headers: { 'content-type': 'image/png', 'content-length': '13' } }));
  assert.deepEqual(binary, { type: 'image/png', bytes: '13', body: '[binary omitted]' });
  const large = await responseLogPayload(new Response('x'.repeat(10000), { headers: { 'content-type': 'text/plain' } }), 100);
  assert.equal((large as { truncated: boolean }).truncated, true);
  assert.equal((large as { bytes: number }).bytes, 100);
});

test('plain output contains no ANSI and bounded append logs rotate without retaining secrets', () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-terminal-'));
  const written: string[] = [];
  const terminal = new HelperTerminal({ helperHome: home, version: '1.0.21', device: 'Test PC', output: { isTTY: false, write: value => written.push(value) }, maxFileBytes: 1200, maxFiles: 3 });
  terminal.setStatus({ connection: 'online', job: 'quiz-learn test', updatePhase: 'downloading' });
  for (let i = 0; i < 20; i += 1) terminal.log('TEST', { index: i, password: 'private-value', text: 'Ordinary material '.repeat(20) });
  terminal.close();
  assert.doesNotMatch(written.join(''), /\x1b|private-value/);
  assert.match(written.join(''), /downloading|quiz-learn test/);
  const files = readdirSync(join(home, 'logs'));
  assert.equal(files.length, 3);
  for (const file of files) { assert.ok(statSync(join(home, 'logs', file)).size <= 1200); assert.doesNotMatch(readFileSync(join(home, 'logs', file), 'utf8'), /private-value/); }
});

test('TTY reserves three header rows, redraws on resize and restores the scroll region on close', () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-terminal-tty-'));
  const written: string[] = [];
  let resize: (() => void) | undefined;
  const terminal = new HelperTerminal({ helperHome: home, version: '1.0.21', device: 'Test PC', output: { isTTY: true, rows: 30, columns: 100, write: value => written.push(value), on: (_name, listener) => { resize = listener; }, off: () => { resize = undefined; } } });
  assert.match(written.join(''), /\x1b\[4;30r/);
  terminal.setStatus({ connection: 'online' });
  resize?.();
  terminal.close();
  assert.equal(resize, undefined);
  assert.ok(written.at(-1)?.includes('\x1b[r'));
});
