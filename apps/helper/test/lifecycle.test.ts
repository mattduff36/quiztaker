import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deriveHelperSecret, signJob } from '@quiztaker/core';
import { rememberOutbox, readOutbox } from '../src/outbox.js';
import { replayBeforeHeartbeat } from '../src/reporting.js';
import { startJob } from '../src/executor.js';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { spawn } from 'node:child_process';

test('retained completion is delivered before idle heartbeat, and failed replay prevents it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-reporting-'));
  const previous = process.env.QUIZTAKER_HOME;
  process.env.QUIZTAKER_HOME = home;
  try {
    rememberOutbox('finished-job', {sequence: 3, event: 'completed', occurredAt: new Date().toISOString(), data: {code: 0}});
    const calls: string[] = [];
    const iteration = async (fail: boolean) => {
      await replayBeforeHeartbeat(async () => { calls.push('terminal'); if (fail) throw new Error('offline'); });
      calls.push('idle-heartbeat');
      calls.push('install-update');
    };
    await assert.rejects(iteration(true), /reporting is still pending/);
    assert.deepEqual(calls, ['terminal']);
    assert.equal(readOutbox().length, 1);
    await iteration(false);
    assert.deepEqual(calls, ['terminal', 'terminal', 'idle-heartbeat', 'install-update']);
    assert.equal(readOutbox().length, 0);
  } finally { if (previous == null) delete process.env.QUIZTAKER_HOME; else process.env.QUIZTAKER_HOME = previous; rmSync(home, {recursive: true, force: true}); }
});

test('pause during a hosted proposal prevents the returned action reaching the browser executor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vitriol-proposal-cancel-'));
  const previousHome = process.env.QUIZTAKER_HOME;
  const previousRoot = process.env.QUIZTAKER_AUTOMATION_ROOT;
  process.env.QUIZTAKER_HOME = join(directory, 'home');
  process.env.QUIZTAKER_AUTOMATION_ROOT = directory;
  writeFileSync(join(directory, 'pw-learn-quiz.js'), `console.log('LEARNER_SNAPSHOT {}'); process.stdin.once('data', data => { console.log('RECEIVED ' + data.toString()); process.exit(0); });`);
  const helperId = randomUUID();
  const secret = deriveHelperSecret('integration-master-key-32-characters', helperId);
  const envelope = signJob({jobId:randomUUID(),planId:randomUUID(),attemptId:randomUUID(),helperId,capabilityId:'quiz-learn',capabilityVersion:4,script:'pw-learn-quiz.js',args:[],fingerprint:null,nonce:randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()}, secret);
  let paused = false;
  try {
    const result = await startJob(envelope, helperId, secret, async () => {}, {
      isCancellationRequested: async () => paused,
      proposeLearnerStep: async () => { paused = true; return {action: {type: 'click', id: '1'}}; },
    }).completion;
    assert.match(result.output, /RECEIVED LEARNER_STOP cancelled/);
    assert.doesNotMatch(result.output, /RECEIVED LEARNER_ACTION/);
  } finally {
    if (previousHome == null) delete process.env.QUIZTAKER_HOME; else process.env.QUIZTAKER_HOME = previousHome;
    if (previousRoot == null) delete process.env.QUIZTAKER_AUTOMATION_ROOT; else process.env.QUIZTAKER_AUTOMATION_ROOT = previousRoot;
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Windows instance mutex rejects a second owner and releases only its own reservation', {skip: process.platform !== 'win32'}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-single-instance-'));
  const release = await acquireInstanceLock(home);
  try { await assert.rejects(acquireInstanceLock(home), /already running/); }
  finally { release(); }
  // Release crosses a process boundary; retry admission until that owner has exited.
  let next: (() => void) | undefined;
  for (let attempt = 0; attempt < 20 && !next; attempt++) {
    try { next = await acquireInstanceLock(home); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(next);
  try {
    release();
    await assert.rejects(acquireInstanceLock(home), /already running/);
  } finally { next?.(); rmSync(home, {recursive: true, force: true}); }
});

test('a crashed helper releases its instance reservation without deleting another live lock', {skip: process.platform !== 'win32', timeout: 15_000}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-crashed-instance-'));
  const lockModule = new URL('../src/instance-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireInstanceLock } from ${JSON.stringify(lockModule)}; await acquireInstanceLock(${JSON.stringify(home)}); console.log('READY'); setInterval(() => {}, 1000);`], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    await new Promise<void>((accept, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) accept(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Fixture exited before acquiring its reservation')));
    });
    await assert.rejects(acquireInstanceLock(home), /already running/);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt < 20 && !release; attempt++) {
      try { release = await acquireInstanceLock(home); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(release);
    release();
  } finally { child.kill(); rmSync(home, {recursive: true, force: true}); }
});
