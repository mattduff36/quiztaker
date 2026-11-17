import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HelperTerminal, responseLogPayload, sanitizeLogText, sanitizeLogValue } from '../src/terminal-ui.js';

test('screenshot stdout and long slash tokens cannot block helper heartbeats', () => {
  // A process timeout also catches synchronous regex hangs that a test timer cannot.
  const source = `import { sanitizeLogText, sanitizeLogValue } from ${JSON.stringify(new URL('../src/terminal-ui.ts', import.meta.url).href)};
    const payload = 'ab/cd/'.repeat(11000);
    const safe = sanitizeLogValue({text:'LEARNER_SNAPSHOT '+JSON.stringify({image:'data:image/jpeg;base64,'+payload})});
    if (JSON.stringify(safe).includes('ab/cd/')) throw Error('Embedded screenshot leaked');
    sanitizeLogText('ordinary '+payload);
    if(sanitizeLogText('GET /api/jobs/abc?qs=value') !== 'GET /api/jobs/abc') throw Error('Query not redacted');
    console.log('responsive');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {timeout:5000,encoding:'utf8'});
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /responsive/);
});

test('redacts credentials, embedded JSON, query strings and binary while retaining ordinary course text', () => {
  const raw = { authorization: 'Bearer device-private', apiKey: 'private-api', encryptedDeviceSecret: 'private-dpapi', signature: 'private-signature', nonce: 'private-nonce', cookie: 'session=private-cookie', url: 'https://example.invalid/course?user_cookie=private-session#secret', screenshot: 'private-image', text: 'Paper thickness is calliper.' };
  const safe = JSON.stringify(sanitizeLogValue(raw));
  assert.doesNotMatch(safe, /private-/);
  assert.match(safe, /Paper thickness is calliper/);
  assert.match(safe, /https:\/\/example.invalid\/course/);
  const embedded = sanitizeLogText('LEARNER_SNAPSHOT {\\"apiKey\\":\\"private-key\\", "url":"https://example.invalid/course?qs=private-session"} Bearer private-bearer');
  assert.doesNotMatch(embedded, /private-|qs=/);
  assert.equal(sanitizeLogText('GET /lms/player?qs=private-session'), 'GET /lms/player');
  assert.equal(sanitizeLogText('path=/lms/player?qs=private-session'), 'path=/lms/player');
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

test('the console shows only activity and connection changes while diagnostics remain in rotating logs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-terminal-'));
  const written: string[] = [];
  const terminal = new HelperTerminal({ helperHome: home, version: '1.0.31', output: { isTTY: false, write: value => written.push(value) }, maxFileBytes: 1200, maxFiles: 3 });
  terminal.setConnection('online');
  terminal.setConnection('online');
  terminal.sent('POST', '/api/helper/heartbeat', '{"status":"online"}');
  await terminal.received('POST', '/api/helper/heartbeat', new Response('{"debug":"private-detail"}', { headers: { 'content-type': 'application/json' } }), 10);
  assert.match(readFileSync(join(home, 'logs', 'helper-live.jsonl'), 'utf8'), /private-detail/);
  terminal.activity('Working · Work on course');
  for (let i = 0; i < 20; i += 1) terminal.log('TEST', { index: i, password: 'private-value', text: 'Ordinary material '.repeat(20) });
  terminal.activity('Done · Work on course', 'ready');
  terminal.close();
  assert.deepEqual(written, [
    'Vitriol Helper 1.0.31 · Connecting…\n',
    'Ready · Connected to Vitriol.\n',
    'Working · Work on course\n',
    'Done · Work on course\n',
  ]);
  const files = readdirSync(join(home, 'logs'));
  assert.equal(files.length, 3);
  for (const file of files) { assert.ok(statSync(join(home, 'logs', file)).size <= 1200); assert.doesNotMatch(readFileSync(join(home, 'logs', file), 'utf8'), /private-value/); }
});

test('TTY colors each activity on one line without changing the scroll region', () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-terminal-tty-'));
  const written: string[] = [];
  const terminal = new HelperTerminal({ helperHome: home, version: '1.0.31', output: { isTTY: true, write: value => written.push(value) } });
  terminal.setConnection('online');
  terminal.setConnection('reconnecting');
  terminal.close();
  assert.deepEqual(written, [
    '\x1b[36mVitriol Helper 1.0.31 · Connecting…\x1b[0m\n',
    '\x1b[32mReady · Connected to Vitriol.\x1b[0m\n',
    '\x1b[33mConnection interrupted · Retrying…\x1b[0m\n',
  ]);
});
