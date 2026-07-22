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
