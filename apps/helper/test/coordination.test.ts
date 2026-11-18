import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { askCoordinator, coordinateDecision } from '../src/coordination.js';

test('the connected chat can answer a bounded observation, with only observed actions returned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vitriol-coordination-'));
  const directory = join(home, 'coordination');
  await mkdir(directory);
  await writeFile(join(directory, 'connection.json'), JSON.stringify({ id: 'connection', expiresAt: Date.now() + 30_000 }));
  const exchange: string[] = [];
  const waiting = askCoordinator(home, 'job', {
    url: 'https://example.com/course?token=private-value',
    buttons: [{ id: 'b1', name: 'Next', kind: 'content' }],
    image: 'data:image/jpeg;base64,private-image',
  }, 'Select the next step', 5_000, undefined, line => exchange.push(line));
  try {
    let filename;
    for (let attempt = 0; attempt < 50 && !filename; attempt++) {
      filename = (await readdir(directory)).find(name => name.endsWith('.request.json'));
      if (!filename) await delay(30);
    }
    assert.ok(filename);
    const raw = await readFile(join(directory, filename), 'utf8');
    assert.doesNotMatch(raw, /private-value|private-image/);
    const request = JSON.parse(raw);
    const reply = join(directory, `${request.id}.reply.json`);
    const respond = (targetId: string) => writeFile(reply, JSON.stringify({
      id: request.id, connectionId: request.connectionId, action: { action: 'click', targetId },
    }));
    await respond('b99');
    await delay(800);
    await respond('b1');
    assert.deepEqual(await waiting, { action: 'click', targetId: 'b1' });
    assert.deepEqual(exchange, ['Vitriol → ChatGPT · Select the next step', 'ChatGPT → Vitriol · Click Next.']);
    assert.deepEqual(await readdir(directory), ['connection.json']);
  } finally {
    await waiting;
    await rm(home, { recursive: true, force: true });
  }
});

test('routine actions continue automatically and blocked clicks ask once before pausing', async () => {
  const automatic = { action: { action: 'scroll', direction: 'down' } };
  const decide = async () => automatic;
  let asked = 0;
  const unavailable = async () => { asked++; return undefined; };
  assert.deepEqual(await coordinateDecision(decide, unavailable, {}), automatic);
  assert.equal(asked, 0);
  const blocked = await coordinateDecision(decide, unavailable, { blockedControl: true });
  assert.equal((blocked.action as { action: string }).action, 'ask-user');
  assert.equal(asked, 1);
  const repeatedCapture = await coordinateDecision(decide, unavailable, { screenshotBlocked: true });
  assert.equal((repeatedCapture.action as { action: string }).action, 'ask-user');
  assert.equal(asked, 2);
  const action = { action: 'click', targetId: 'b1' } as const;
  assert.deepEqual(await coordinateDecision(decide, async () => action, { coordinationStart: true }), { action });
  const disconnected=await coordinateDecision(decide, unavailable, {coordinationStart:true});
  assert.equal((disconnected.action as {action:string}).action,'ask-user');
  assert.match((disconnected.action as {question:string}).question,/ChatGPT is not connected/);
  const original={action:{action:'ask-user',question:'Open Launch course'}};
  const missing=await coordinateDecision(async()=>original,unavailable,{});
  assert.match((missing.action as {question:string}).question,/ChatGPT is not connected/);
});

test('absent and expired chat connections report unavailability without creating requests',async()=>{
 const home=await mkdtemp(join(tmpdir(),'vitriol-disconnected-'));const directory=join(home,'coordination');
 try {
  const lines:string[]=[];
  assert.equal(await askCoordinator(home,'job',{},'Start',100,undefined,line=>lines.push(line)),undefined);
  await mkdir(directory);await writeFile(join(directory,'connection.json'),JSON.stringify({id:'old-private-id',expiresAt:Date.now()-1}));
  assert.equal(await askCoordinator(home,'job',{},'Start',100,undefined,line=>lines.push(line)),undefined);
  assert.equal(lines.length,2);assert.ok(lines.every(line=>/not connected/.test(line)));assert.doesNotMatch(lines.join(''),/old-private-id/);
  assert.deepEqual(await readdir(directory),['connection.json']);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('unchanged-action blocker reaches coordination before a visible resumable timeout',async()=>{
  let calls=0;
  const snapshot={question:{id:'a'.repeat(64),number:6,total:10,stem:'Fresh matching question'},unchangedAction:true};
  const corrected=await coordinateDecision(async()=>assert.fail('Do not ask the model again'),async(view,reason)=>{
    calls++;assert.equal(view.question?.number,6);assert.match(reason,/unchanged/);
    return {action:'click',targetId:'m1'};
  },snapshot);
  assert.deepEqual(corrected,{action:{action:'click',targetId:'m1'}});
  const unavailable=await coordinateDecision(async()=>assert.fail(),async()=>undefined,snapshot);
  assert.match((unavailable.action as {question:string}).question,/resume without restarting/);
  assert.equal(calls,1);
});

test('a connected coordinator timeout is visible, cleans exchange files and preserves the fresh question identity',async()=>{
  const home=await mkdtemp(join(tmpdir(),'vitriol-coordination-timeout-'));
  const directory=join(home,'coordination');await mkdir(directory);
  await writeFile(join(directory,'connection.json'),JSON.stringify({id:'connected',expiresAt:Date.now()+10000}));
  const exchange:string[]=[];
  try {
    const pending=askCoordinator(home,'job',{
      question:{id:'c'.repeat(64),number:6,total:10,stem:'Current question, not Q5'},
      imageIdentity:{id:'fresh-screen',questionId:'c'.repeat(64)},image:'data:image/jpeg;base64,private-image',
    },'Inspect current question',800,undefined,line=>exchange.push(line));
    let filename:string|undefined;
    for(let attempt=0;attempt<30&&!filename;attempt++) {
      filename=(await readdir(directory)).find(name=>name.endsWith('.request.json'));
      if(!filename)await delay(20);
    }
    assert.ok(filename);
    const request=JSON.parse(await readFile(join(directory,filename),'utf8'));
    assert.equal(request.snapshot.question.number,6);assert.equal(request.snapshot.imageIdentity.id,'fresh-screen');
    assert.equal(request.snapshot.image,undefined);
    assert.equal(await pending,undefined);
    assert.match(exchange.at(-1)||'',/timed out or disconnected.*resume without restarting/);
    assert.deepEqual(await readdir(directory),['connection.json']);
  }finally{await rm(home,{recursive:true,force:true});}
});
