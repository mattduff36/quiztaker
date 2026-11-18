import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHistorySync, localSyncBatches, readLocalCaptures, readLocalHistory, readLocalReviews, type LocalSyncPayload } from '../src/sync.js';

const rows = (length: number, prefix: string) => Array.from({length}, (_, i) => ({sourceId:`${prefix}-${i}`}));

test('all local streams batch losslessly within API limits, with stable source deduplication', () => {
  const payload = {history:rows(1001,'h'),reviews:rows(401,'r'),captures:rows(201,'c')};
  payload.captures.push(payload.captures[0]);
  const batches = localSyncBatches(payload);
  assert.equal(batches.length,3);
  for (const batch of batches) {
    assert.ok(batch.history.length<=500 && batch.reviews.length<=200 && batch.captures.length<=100);
  }
  for (const stream of ['history','reviews','captures'] as const) {
    assert.deepEqual(batches.flatMap(batch=>batch[stream]), [...new Map(payload[stream].map(row=>[row.sourceId,row])).values()]);
  }
});

test('failed or stalled sync never holds heartbeat/poll; retry retains exact batch and acknowledged progress', async () => {
  let now=0, fail=true, reads=0, polls=0, heartbeats=0;
  const sent: LocalSyncPayload[]=[], errors: unknown[]=[];
  const sync = new LocalHistorySync(async batch=>{
    sent.push(structuredClone(batch));
    if (sent.length===2 && fail) throw new Error('fixture sync failure');
  }, error=>errors.push(error), ()=>{reads++;return {history:[],reviews:[],captures:rows(201,'c')};}, ()=>now);
  const loop=async()=>{heartbeats++;void sync.tick();polls++;await sync.tick();};
  await loop();await loop();await loop();
  assert.equal(polls,3);assert.equal(heartbeats,3);assert.equal(sent.length,2);assert.equal(errors.length,1);
  now=30_000;fail=false;
  await loop();assert.deepEqual(sent[2],sent[1]);
  await loop();assert.equal(sent[3].captures.length,1);assert.equal(reads,1);
  await loop();assert.equal(sent.length,4);
  now+=300_000;await loop();assert.equal(reads,2);
  let release!:()=>void;
  const stalled = new LocalHistorySync(()=>new Promise<void>(resolve=>{release=resolve;}),error=>{throw error;},
    ()=>({history:rows(1,'h'),reviews:[],captures:[]}));
  const pending=stalled.tick();
  assert.equal(stalled.tick(),pending,'overlapping ticks do not duplicate in-flight batches');
  heartbeats++;polls++;
  assert.equal(polls,8);assert.equal(heartbeats,8);
  release();await pending;
});

test('local ledgers remain untouched; malformed timestamps and missing capture IDs stay stable on reread', () => {
  const directory=mkdtempSync(join(tmpdir(),'vitriol-sync-'));
  const oldHome=process.env.QUIZTAKER_HOME,oldRoot=process.env.QUIZTAKER_AUTOMATION_ROOT;
  process.env.QUIZTAKER_HOME=directory;process.env.QUIZTAKER_AUTOMATION_ROOT=directory;
  try {
    mkdirSync(join(directory,'data','course-history'),{recursive:true});
    mkdirSync(join(directory,'data','learn'),{recursive:true});
    mkdirSync(join(directory,'data','knowledge'),{recursive:true});
    const file=join(directory,'data','learn','index.jsonl');
    const text=JSON.stringify({title:'Fixture capture'})+'\n';
    writeFileSync(file,text);
    writeFileSync(join(directory,'data','course-history','certifications.jsonl'),
      [{cert:'Fixture',ts:'invalid',result:'one'},{cert:'Fixture',ts:'invalid',result:'two'}].map(row=>JSON.stringify(row)).join('\n')+'\n');
    writeFileSync(join(directory,'data','knowledge','review-queue.jsonl'),
      [{title:'First',ts:'same'},{title:'Second',ts:'same'}].map(row=>JSON.stringify(row)).join('\n')+'\n');
    assert.deepEqual(readLocalHistory(),readLocalHistory());
    assert.deepEqual(readLocalCaptures(),readLocalCaptures());
    assert.notEqual(readLocalCaptures()[0].sourceId,'undefined');
    assert.equal(readLocalHistory().length,2,'distinct undated events are not collapsed');
    assert.equal(localSyncBatches({history:[],reviews:readLocalReviews(),captures:[]})[0].reviews.length,2,'same-timestamp reviews remain distinct');
    assert.equal(readFileSync(file,'utf8'),text);
  } finally {
    if(oldHome===undefined)delete process.env.QUIZTAKER_HOME;else process.env.QUIZTAKER_HOME=oldHome;
    if(oldRoot===undefined)delete process.env.QUIZTAKER_AUTOMATION_ROOT;else process.env.QUIZTAKER_AUTOMATION_ROOT=oldRoot;
    rmSync(directory,{recursive:true,force:true});
  }
});

test('a lost acknowledgement and helper restart replay identical sources without dropping later batches',async()=>{
  const stored=new Set<string>(),attempted:string[][]=[];
  const payload={history:[],reviews:[],captures:rows(201,'capture')};
  let now=0,lost=true;
  const send=async(batch:LocalSyncPayload)=>{
    const ids=batch.captures.map(row=>String(row.sourceId));attempted.push(ids);
    for(const id of ids)stored.add(id);
    if(lost){lost=false;throw new Error('Response lost after storage');}
  };
  const first=new LocalHistorySync(send,()=>{},()=>payload,()=>now);
  await first.tick();now=30_000;await first.tick();
  assert.deepEqual(attempted[0],attempted[1]);
  const restarted=new LocalHistorySync(send,()=>{},()=>payload,()=>now);
  await restarted.tick();await restarted.tick();await restarted.tick();
  assert.equal(stored.size,201);
  assert.deepEqual([...stored],payload.captures.map(row=>row.sourceId));
});
