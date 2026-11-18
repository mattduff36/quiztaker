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
  const first = replaceBrowserSession([{ idx: 1, cdpTargetId:'live-a', title: 'Course', url: 'https://example.com/course?curriculum=A', hasFocus: true }]);
  const second = replaceBrowserSession([{ idx: 4, cdpTargetId:'live-a', title: 'Course', url: 'https://example.com/course?curriculum=A', hasFocus: false }]);
  assert.equal(second.id, first.id);
  assert.equal(second.tabs[0]?.targetId, first.tabs[0]?.targetId);
  assert.equal(second.revision, first.revision+1);
  const twins = replaceBrowserSession([
    { idx: 1, cdpTargetId:'live-a', title: 'Course', url: 'https://example.com/course?curriculum=A' },
    { idx: 2, cdpTargetId:'live-b', title: 'Course', url: 'https://example.com/course?curriculum=B' },
  ]);
  assert.notEqual(twins.tabs[0]?.targetId, twins.tabs[1]?.targetId);
  assert.equal(twins.tabs[0]?.targetId, first.tabs[0]?.targetId);
  const twinsAgain = replaceBrowserSession([
    { idx: 1, cdpTargetId:'live-b', title: 'Course', url: 'https://example.com/course?curriculum=B' },
    { idx: 2, cdpTargetId:'live-a', title: 'Loading', url: 'https://example.com/transition' },
  ]);
  assert.equal(twinsAgain.tabs[0]?.targetId, twins.tabs[1]?.targetId);
  assert.equal(twinsAgain.tabs[1]?.targetId, twins.tabs[0]?.targetId);
  assert.equal(twinsAgain.revision,twins.revision+1);
  assert.deepEqual(resolveScriptArgs('scorm-complete', [
    '--target', twins.tabs[1].targetId,
    '--session', twins.id,
    '--revision', String(twins.revision),
    '--fingerprint', twins.tabs[1].fingerprint,
  ], twins), ['2']);
  replaceBrowserSession([{ idx:1,cdpTargetId:'live-b',title:'Course',url:'https://example.com/course?curriculum=B'}]);
  const reopened=replaceBrowserSession([{idx:1,cdpTargetId:'live-b',title:'Course',url:'https://example.com/course?curriculum=B'},
    {idx:2,cdpTargetId:'live-c',title:'Course',url:'https://example.com/course?curriculum=A'}]);
  assert.notEqual(reopened.tabs[1].targetId,first.tabs[0].targetId);
  const args = [
    '--target', first.tabs[0].targetId,
    '--session', first.id,
    '--revision', String(first.revision),
    '--fingerprint', first.tabs[0].fingerprint,
  ];
  assert.throws(() => resolveScriptArgs('scorm-complete', args, readBrowserSession()), /stale/);
  const legacy=replaceBrowserSession([{idx:0,title:'Course',url:'https://example.com/course'}]);
  assert.notEqual(replaceBrowserSession([{idx:0,title:'Course',url:'https://example.com/course'}]).tabs[0].targetId,legacy.tabs[0].targetId);
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
