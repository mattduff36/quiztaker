import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveScriptArgs } from '@quiztaker/core';
import { isAllowedArtifact } from '../src/artifacts.js';
import { readBrowserSession, replaceBrowserSession } from '../src/browser-session.js';
import { readOutbox, rememberOutbox, replaceOutbox, takeOutboxBatch } from '../src/outbox.js';

test('browser targets stay stable and script args reject a stale revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiztaker-session-'));
  process.env.QUIZTAKER_HOME = directory;
  const first = replaceBrowserSession([{ idx: 1, title: 'Course', url: 'https://example.com/course', hasFocus: true }]);
  const second = replaceBrowserSession([{ idx: 4, title: 'Course', url: 'https://example.com/course', hasFocus: false }]);
  assert.equal(second.id, first.id);
  assert.equal(second.tabs[0]?.targetId, first.tabs[0]?.targetId);
  assert.equal(second.revision, first.revision);
  const twins = replaceBrowserSession([
    { idx: 1, title: 'Course', url: 'https://example.com/course' },
    { idx: 2, title: 'Course', url: 'https://example.com/course' },
  ]);
  assert.notEqual(twins.tabs[0]?.targetId, twins.tabs[1]?.targetId);
  assert.notEqual(twins.tabs[0]?.targetId, first.tabs[0]?.targetId);
  const twinsAgain = replaceBrowserSession([
    { idx: 1, title: 'Course', url: 'https://example.com/course' },
    { idx: 2, title: 'Course', url: 'https://example.com/course' },
  ]);
  assert.equal(twinsAgain.tabs[0]?.targetId, twins.tabs[0]?.targetId);
  assert.equal(twinsAgain.tabs[1]?.targetId, twins.tabs[1]?.targetId);
  assert.deepEqual(resolveScriptArgs('scorm-complete', [
    '--target', twins.tabs[1].targetId,
    '--session', twins.id,
    '--revision', String(twins.revision),
    '--fingerprint', twins.tabs[1].fingerprint,
  ], twins), ['2']);
  const moved = replaceBrowserSession([{ idx: 2, title: 'Other', url: 'https://example.com/other' }]);
  assert.equal(moved.revision, first.revision + 2);
  const args = [
    '--target', first.tabs[0].targetId,
    '--session', first.id,
    '--revision', String(first.revision),
    '--fingerprint', first.tabs[0].fingerprint,
  ];
  assert.throws(() => resolveScriptArgs('scorm-complete', args, readBrowserSession()), /stale/);
  rmSync(directory, { recursive: true, force: true });
});

test('outbox replays until replaced and artifacts stay inside helper roots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiztaker-outbox-'));
  process.env.QUIZTAKER_HOME = directory;
  process.env.QUIZTAKER_AUTOMATION_ROOT = directory;
  rememberOutbox('job', { sequence: 1, event: 'completed', data: { ok: true }, occurredAt: new Date().toISOString() });
  assert.equal(readOutbox().length, 1);
  replaceOutbox([]);
  assert.equal(readOutbox().length, 0);
  assert.equal(isAllowedArtifact(join(directory, 'capture.json')), true);
  assert.equal(isAllowedArtifact(join(directory, '..', 'secret.txt')), false);
  rememberOutbox('kept', { sequence: 1, event: 'completed', data: { ok: true }, occurredAt: new Date().toISOString() });
  const batch = takeOutboxBatch();
  rememberOutbox('arrived-during-send', { sequence: 2, event: 'completed', data: { ok: true }, occurredAt: new Date().toISOString() });
  batch.commit(batch.events);
  const pending = readOutbox();
  assert.deepEqual(pending.map((item) => item.jobId), ['kept', 'arrived-during-send']);
  const sent = takeOutboxBatch();
  rememberOutbox('later', { sequence: 3, event: 'completed', data: { ok: true }, occurredAt: new Date().toISOString() });
  sent.commit([]);
  assert.deepEqual(readOutbox().map((item) => item.jobId), ['later']);
  rmSync(directory, { recursive: true, force: true });
});
