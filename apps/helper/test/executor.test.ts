import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveHelperSecret, signJob, type JobEventInput } from '@quiztaker/core';
import { startJob } from '../src/executor.js';

test('executes a valid signed job through the local whitelist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiztaker-helper-test-'));
  const home = join(directory, 'home');
  process.env.QUIZTAKER_HOME = home;
  process.env.QUIZTAKER_AUTOMATION_ROOT = directory;
  writeFileSync(join(directory, 'pw-list-tabs.js'), 'console.log("fake executor completed");\n');

  const helperId = '9c60d37a-a023-475a-af4f-a89a81903e47';
  const secret = deriveHelperSecret('integration-master-key-32-characters', helperId);
  const envelope = signJob({
    jobId: 'b4e08cdd-5bd8-4981-a4ae-cf7f699aa37d',
    planId: '488fa8b8-82f5-45df-890f-67c24f525675',
    attemptId: '552b4776-3c91-4fc9-bee4-1b0bc2170fe0',
    helperId,
    capabilityId: 'list-tabs',
    capabilityVersion: 1,
    script: 'pw-list-tabs.js',
    args: [],
    fingerprint: null,
    nonce: 'dfb21119-f1b6-4dd3-aeb7-3c02cbff1d9a',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, secret);
  const events: JobEventInput[] = [];
  const run = startJob(envelope, helperId, secret, async (event) => {
    events.push(event);
  });
  const result = await run.completion;

  assert.equal(result.code, 0);
  assert.match(result.output, /fake executor completed/);
  assert.deepEqual(events.map((event) => event.event), ['accepted', 'started', 'stdout', 'completed']);
  assert.throws(() => startJob(envelope, helperId, secret, async () => {}), /nonce has already been used/);
  rmSync(directory, { recursive: true, force: true });
});

test('reports cancellation as the only terminal event', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiztaker-helper-cancel-test-'));
  process.env.QUIZTAKER_HOME = join(directory, 'home');
  process.env.QUIZTAKER_AUTOMATION_ROOT = directory;
  writeFileSync(join(directory, 'pw-list-tabs.js'), 'setTimeout(() => {}, 30_000);\n');

  const helperId = '177aa5e8-1f86-4a6d-a719-0a1282053b48';
  const secret = deriveHelperSecret('integration-master-key-32-characters', helperId);
  const envelope = signJob({
    jobId: '92a21df0-62b0-42a7-8f8e-5d85947f80b8',
    planId: 'ddf85569-65e5-497c-9698-28d17fe408f5',
    attemptId: '3a5c9105-ce60-49f6-bf90-57d4d2857680',
    helperId,
    capabilityId: 'list-tabs',
    capabilityVersion: 1,
    script: 'pw-list-tabs.js',
    args: [],
    fingerprint: null,
    nonce: '67e57b9e-a7e5-4247-8607-f7412b3753f7',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, secret);
  const events: JobEventInput[] = [];
  const run = startJob(envelope, helperId, secret, async (event) => {
    events.push(event);
  });
  run.cancel();
  await run.completion;

  const terminalEvents = events.filter((event) => (
    event.event === 'completed' || event.event === 'failed' || event.event === 'cancelled'
  ));
  assert.deepEqual(terminalEvents.map((event) => event.event), ['cancelled']);
  rmSync(directory, { recursive: true, force: true });
});
