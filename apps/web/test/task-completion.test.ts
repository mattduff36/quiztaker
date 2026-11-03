import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import {finishOperatorTask,readLatestTask,taskStillStopping} from '../src/lib/task-completion';
import {recordJobEvent} from '../src/lib/jobs';
import type {SqlQuery} from '../src/lib/db';

test('operator task closure waits only for the matching live helper, never an offline helper or automatic result',()=>{
  const now=Date.now();const job={id:'job',outcome:{operatorResolution:{result:'completed',reportedBy:'operator'}}};
  assert.equal(taskStillStopping(job,{active_job_id:'job',last_seen_at:new Date(now).toISOString()},now),true);
  assert.equal(taskStillStopping(job,{active_job_id:'other',last_seen_at:new Date(now).toISOString()},now),false);
  assert.equal(taskStillStopping(job,{active_job_id:'job',last_seen_at:new Date(now-121000).toISOString()},now),false);
  assert.equal(taskStillStopping({id:'job',outcome:{verified:true}},{active_job_id:'job',last_seen_at:new Date(now).toISOString()},now),false);
});

const url=process.env.VITRIOL_RECOVERY_TEST_DATABASE_URL;
test('Postgres: direct task finish is owner-scoped, idempotent, keeps facts and cannot be overwritten by late helper events',{skip:!url},async()=>{
  const target=new URL(url!);assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.ok(target.pathname.startsWith('/vitriol_regression'));
  const db=postgres(url!,{max:4,prepare:false});const user=`finish-${randomUUID()}`,helper=randomUUID(),browser=randomUUID(),conversation=randomUUID();
  const params=(text:string,values:unknown[])=>{const json=new Set([...text.matchAll(/\$(\d+)::jsonb/g)].map(m=>Number(m[1])-1));return values.map((v,i)=>json.has(i)&&typeof v==='string'?JSON.parse(v):v) as never[];};
  const query:SqlQuery=async<T>(text:string,values:unknown[]=[])=>Array.from(await db.unsafe(text,params(text,values))) as T[];
  const transaction=async<T>(fn:(sql:SqlQuery)=>Promise<T>):Promise<T>=>await db.begin(async tx=>fn(async<R>(text:string,values:unknown[]=[])=>Array.from(await tx.unsafe(text,params(text,values))) as R[])) as T;
  const deps={query,transaction,now:()=>new Date()};
  async function makeJob(capability='quiz-learn',status='awaiting-input') {
    const id=randomUUID();
    const [plan]=await db`insert into plans(user_id,helper_id,source,capability_id,capability_version,script,label,risk,mutates_course,verifier,confirmed,expires_at,browser_session_id,input)
      values(${user},${helper},'manual-capability',${capability},4,'pw-learn-quiz.js','Task fixture','high',true,'quiz-result-passed',true,now()+interval '5 minutes',${browser},${db.json({conversationId:conversation})}) returning id,attempt_id`;
    await db`insert into jobs(id,user_id,helper_id,plan_id,attempt_id,capability_id,capability_version,script,status,input,outcome)
      values(${id},${user},${helper},${plan.id},${plan.attempt_id},${capability},4,'pw-learn-quiz.js',${status},${db.json({conversationId:conversation})},'{}')`;
    return id;
  }
  try {
    await db`insert into profiles(id,email) values(${user},${user+'@example.invalid'})`;
    await db`insert into helpers(id,user_id,device_name,version,status,last_seen_at) values(${helper},${user},'Finish fixture','1.0.22','online',now())`;
    await db`insert into browser_sessions(id,user_id,helper_id,revision,cdp_connected,tabs) values(${browser},${user},${helper},1,true,'[]')`;
    await db`insert into learner_sessions(id,user_id,helper_id,browser_session_id,history,materials) values(${conversation},${user},${helper},${browser},'[{}]','[{"text":"Saved course facts"}]')`;
    const id=await makeJob();const request={userId:user,helperId:helper,jobId:id,result:'completed' as const,note:'Visible score75%'};
    await assert.rejects(finishOperatorTask({...request,userId:'not-owner'},deps),/not found/);
    await assert.rejects(finishOperatorTask({...request,helperId:randomUUID()},deps),/not found/);
    const [a,b]=await Promise.all([finishOperatorTask(request,deps),finishOperatorTask(request,deps)]);assert.equal(a.status,'completed');assert.equal(b.status,'completed');
    const [saved]=await db`select status,outcome,cancel_requested from jobs where id=${id}`;
    assert.equal(saved.status,'completed');assert.equal(saved.cancel_requested,true);assert.equal(saved.outcome.verified,false);assert.equal(saved.outcome.status,'operator-completed');
    assert.equal((await db`select count(*)::int n from attempt_events where user_id=${user} and event='operator-task-finished'`)[0].n,1);
    const [memory]=await db`select history,materials from learner_sessions where id=${conversation}`;assert.equal(memory.materials[0].text,'Saved course facts');assert.equal(JSON.parse(memory.history.at(-1).text).taskFinished,'completed');
    await recordJobEvent(helper,user,id,{sequence:99,event:'completed',occurredAt:new Date().toISOString(),data:{code:0,output:'AUTOMATION_RESULT {"completed":1,"total":1}'}},{queryOne:async<T>(text:string,values:unknown[]=[])=>((await query<T>(text,values))[0]??null),queryRows:query,withTransaction:transaction});
    assert.equal((await db`select outcome from jobs where id=${id}`)[0].outcome.status,'operator-completed');
    assert.equal((await db`select count(*)::int n from strategies where user_id=${user}`)[0].n,0);
    const maintenance=await makeJob('list-tabs','completed');assert.equal((await readLatestTask(user,helper,query))?.id,id);
    await assert.rejects(finishOperatorTask({...request,jobId:maintenance},deps),/connection check/);
    const running=await makeJob('quiz-learn','running');await db`update helpers set active_job_id=${running},last_seen_at=now() where id=${helper}`;
    const closing=await finishOperatorTask({...request,jobId:running,result:'failed'},deps);assert.equal(closing.status,'stopping');assert.equal((await readLatestTask(user,helper,query))?.stopping,true);
    await assert.rejects(finishOperatorTask(request,deps),/current task changed/);
    await db`update helpers set active_job_id=null where id=${helper}`;assert.equal((await readLatestTask(user,helper,query))?.stopping,false);
  } finally {await db`delete from profiles where id=${user}`;await db.end();}
});
