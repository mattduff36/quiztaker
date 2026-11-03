import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveHelperSecret, signJob, type JobEventInput } from '@quiztaker/core';
import { startJob } from '../src/executor.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ControlPlaneClient, flushPendingEvents } from '../src/client.js';
import { readOutbox } from '../src/outbox.js';

test('Windows crash status and failed event reporting preserve terminal intent without stopping the helper', {skip:process.platform!=='win32'}, async () => {
  const directory = mkdtempSync(join(tmpdir(),'vitriol-crash-report-'));
  process.env.QUIZTAKER_HOME=join(directory,'home');
  process.env.QUIZTAKER_AUTOMATION_ROOT=directory;
  writeFileSync(join(directory,'pw-list-tabs.js'),'process.exit(3221226505);');
  let failEvents=true;let attempts=0;let heartbeats=0;
  const received: JobEventInput[]=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url?.endsWith('/events')) {
      attempts+=1;
      if(failEvents){res.statusCode=500;res.end(JSON.stringify({error:'fixture database reporting failure'}));return;}
      received.push(JSON.parse(text));
    } else if(req.url?.endsWith('/heartbeat')) {heartbeats+=1;}
    res.end(JSON.stringify({ok:true,update:null}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const helperId=randomUUID();const secret=deriveHelperSecret('integration-master-key-32-characters',helperId);
  const client=new ControlPlaneClient({schemaVersion:1,helperId,controlPlaneUrl:`http://127.0.0.1:${address.port}`,encryptedDeviceSecret:`plain:${Buffer.from('fixture-only-secret').toString('base64')}`,deviceName:'Offline fixture',pairedAt:new Date().toISOString()});
  const makeEnvelope=()=>signJob({jobId:randomUUID(),planId:randomUUID(),attemptId:randomUUID(),helperId,capabilityId:'list-tabs',capabilityVersion:1,script:'pw-list-tabs.js',args:[],fingerprint:null,nonce:randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()},secret);
  try {
    const envelope=makeEnvelope();
    const result=await startJob(envelope,helperId,secret,event=>client.sendEvent(envelope.payload.jobId,event)).completion;
    assert.equal(result.code,-1073740791);
    assert.match(result.output,/0xC0000409.*3221226505/);
    assert.equal(attempts,4,'one bounded request sequence, remaining events defer to the existing outbox');
    const pending=readOutbox();
    const terminal=pending.find(item=>item.event.event==='failed')!;
    assert.equal(terminal.event.data.code,-1073740791);
    assert.equal(terminal.event.data.rawCode,3221226505);
    assert.equal(terminal.jobId,envelope.payload.jobId);
    await client.heartbeat({status:'online'});
    assert.equal(heartbeats,1);
    let replayCalls=0;
    await flushPendingEvents(async()=>{replayCalls+=1;throw new Error('still unavailable');});
    assert.equal(replayCalls,1);
    assert.equal(readOutbox().length,pending.length);
    failEvents=false;
    await flushPendingEvents((jobId,event)=>client.sendEvent(jobId,event));
    assert.equal(readOutbox().length,0);
    assert.ok(received.some(event=>event.event==='failed'&&event.data.rawCode===3221226505));
    writeFileSync(join(directory,'pw-list-tabs.js'),'console.log("subsequent job completed");');
    const next=makeEnvelope();
    assert.equal((await startJob(next,helperId,secret,event=>client.sendEvent(next.payload.jobId,event)).completion).code,0);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});

test('signed learner intent reaches the executor and old jobs override inherited quiz mode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vitriol-learner-mode-'));
  process.env.QUIZTAKER_HOME = join(directory, 'home');
  process.env.QUIZTAKER_AUTOMATION_ROOT = directory;
  process.env.VITRIOL_LEARNER_MODE = 'quiz';
  writeFileSync(join(directory,'pw-learn-quiz.js'), 'console.log("MODE=" + process.env.VITRIOL_LEARNER_MODE);');
  const helperId = randomUUID();
  const secret = deriveHelperSecret('integration-master-key-32-characters', helperId);
  try {
    for (const mode of [undefined, 'read', 'quiz']) {
      const envelope = signJob({jobId:randomUUID(),planId:randomUUID(),attemptId:randomUUID(),helperId,capabilityId:'quiz-learn',capabilityVersion:3,script:'pw-learn-quiz.js',args:[],fingerprint:null,nonce:randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),input:mode?{mode}:{}},secret);
      const result = await startJob(envelope,helperId,secret,async()=>{}, {proposeLearnerStep:async()=>({stop:true})}).completion;
      assert.equal(result.code,0);
      assert.match(result.output,new RegExp(`MODE=${mode || 'read'}`));
      envelope.payload.input = {mode: mode==='quiz'?'read':'quiz'};
      assert.throws(()=>startJob(envelope,helperId,secret,async()=>{}), /signature/);
    }
  } finally { delete process.env.VITRIOL_LEARNER_MODE; rmSync(directory,{recursive:true,force:true}); }
});

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
