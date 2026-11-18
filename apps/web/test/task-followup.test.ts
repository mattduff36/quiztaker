import test from 'node:test';
import assert from 'node:assert/strict';
import {expireTaskFollowup,armTaskFollowup,cancelTaskFollowup} from '../src/lib/task-followup';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import type {SqlQuery} from '../src/lib/db';
test('follow-up expiry never closes after interaction, pause, new work, manual control, changed session or early deadline',async()=>{
 for(const blocked of ['none','touched','active','preparing','newer','manual','stopping','session','early','cancelled']){
  let state=blocked==='cancelled'?'cancelled':'waiting',closes=0;
  const query:SqlQuery=async<T>(text:string,values:unknown[]=[])=>{
   let rows:unknown[]=[];
   if(text.startsWith('select * from jobs'))rows=[{id:'job',created_at:'2026-01-01',status:'completed',capability_id:'quiz-learn',outcome:{verified:true}}];
   else if(text.startsWith('select id,active_job_id'))rows=[{id:'helper',manual:blocked==='manual',active_job_id:blocked==='stopping'?'job':null}];
   else if(text.startsWith('select *,deadline'))rows=[{state,due:blocked!=='early',browser_session_id:'session',created_at:'2026-01-01'}];
   else if(text.includes('as same_session'))rows=[{same_session:blocked!=='session',active:blocked==='active',touched:blocked==='touched',preparing:blocked==='preparing',newer:blocked==='newer'}];
   else if(text.startsWith('update operations_followups')){if(text.includes("state='closing'"))state='closing';else if(text.includes("state='cancelled'"))state='cancelled';else if(values[3])state=String(values[3]);}
   else throw Error('Unexpected fixture query');
   return rows as T[];
  };
  const deps={query,transaction:async<T>(run:(sql:SqlQuery)=>Promise<T>)=>run(query),endSession:async()=>{closes++;return{status:'ending',closeJobId:'close'};}};
  await expireTaskFollowup('user','helper','job',deps);
  assert.equal(closes,blocked==='none'?1:0,blocked);
  if(blocked==='none'){await expireTaskFollowup('user','helper','job',deps);assert.equal(closes,1,'second device cannot enqueue another close');}
 }
});
test('old tasks are never backfilled and arm stays tied to the original live shared browser session',async()=>{
 let statement='';const query:SqlQuery=async<T>(text:string)=>{statement=text;return [] as T[];};
 await armTaskFollowup(query,{id:'job',helper_id:'helper',user_id:'user',capability_id:'quiz-learn',status:'completed',outcome:{verified:true}});
 assert.match(statement,/finished_at>now\(\)-interval '30 seconds'/);assert.match(statement,/d.session_id=s.id/);assert.match(statement,/s.closed_at is null/);
});
const databaseUrl=process.env.VITRIOL_RECOVERY_TEST_DATABASE_URL;
test('Postgres: shared follow-up has a 20 second deadline, is owner scoped and concurrent devices queue one close',{skip:!databaseUrl},async()=>{
 const target=new URL(databaseUrl!);assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.match(target.pathname,/^\/vitriol_regression/);
 const db=postgres(databaseUrl!,{max:4,prepare:false}),user='followup-'+randomUUID(),helper=randomUUID(),session=randomUUID();
 const query:SqlQuery=async<T>(text:string,values:unknown[]=[])=>Array.from(await db.unsafe(text,values as never[])) as T[];
 const transaction=async<T>(run:(q:SqlQuery)=>Promise<T>)=>await db.begin(tx=>run(async<R>(text:string,values:unknown[]=[])=>Array.from(await tx.unsafe(text,values as never[])) as R[])) as T;
 try{
  await db`insert into profiles(id,email) values(${user},${user+'@example.invalid'})`;
  await db`insert into helpers(id,user_id,device_name,version,status,last_seen_at) values(${helper},${user},'Followup fixture','1.0.50','online',now())`;
  await db`insert into browser_sessions(id,user_id,helper_id,revision,cdp_connected,tabs) values(${session},${user},${helper},1,true,'[]')`;
  await db`insert into operations_drafts(helper_id,user_id,session_id) values(${helper},${user},${session})`;
  const [plan]=await db`insert into plans(user_id,helper_id,browser_session_id,source,capability_id,capability_version,script,label,risk,mutates_course,verifier,confirmed,expires_at) values(${user},${helper},${session},'manual-capability','quiz-learn',7,'pw-learn-quiz.js','Followup','high',true,'quiz-result-passed',true,now()+interval '5 minutes') returning id,attempt_id`;
  const [job]=await db`insert into jobs(user_id,helper_id,plan_id,attempt_id,capability_id,capability_version,script,status,outcome,finished_at) values(${user},${helper},${plan.id},${plan.attempt_id},'quiz-learn',7,'pw-learn-quiz.js','completed','{"verified":true}',now()) returning *`;
  await armTaskFollowup(query,job as never);
  assert.equal((await db`select extract(epoch from deadline-created_at)::int seconds from operations_followups where job_id=${job.id}`)[0].seconds,20);
  await cancelTaskFollowup('wrong-owner',helper,job.id,query);assert.equal((await db`select state from operations_followups where job_id=${job.id}`)[0].state,'waiting');
  await db`update operations_followups set deadline=now()-interval '1 second' where job_id=${job.id}`;
  let closes=0;const deps={query,transaction,endSession:async()=>{closes++;await new Promise(r=>setTimeout(r,30));return{status:'ended',closeJobId:null};}};
  await Promise.all([expireTaskFollowup(user,helper,job.id,deps),expireTaskFollowup(user,helper,job.id,deps)]);
  assert.equal(closes,1);assert.equal((await db`select state from operations_followups where job_id=${job.id}`)[0].state,'closed');
 }finally{await db`delete from profiles where id=${user}`;await db.end();}
});
