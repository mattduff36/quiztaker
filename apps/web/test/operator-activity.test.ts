import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { operatorActivity, enforceOperatorIdle, assertOperatorActive, reserveBrowserRefresh } from '../src/lib/operator-activity';
import type {JobRecoveryDeps} from '../src/lib/job-recovery';

const url=process.env.VITRIOL_RECOVERY_TEST_DATABASE_URL;
test('Postgres: human activity, idle enforcement, explicit resume and cross-tab probe admission',{skip:!url},async()=>{
  const target=new URL(url!);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
  assert.ok(target.pathname.startsWith('/vitriol_regression'));
  const sql=postgres(url!,{max:4,prepare:false});
  const user=`idle-${randomUUID()}`,helper=randomUUID();
  function params(text:string,values:unknown[]){const json=new Set(Array.from(text.matchAll(/\$(\d+)::jsonb/g),match=>Number(match[1])-1));return values.map((value,index)=>json.has(index)&&typeof value==='string'?JSON.parse(value):value) as never[];}
  const query:JobRecoveryDeps['query']=async<T>(text:string,values:unknown[]=[])=>Array.from(await sql.unsafe(text,params(text,values))) as T[];
  const deps:JobRecoveryDeps={query,transaction:async fn=>sql.begin(async tx=>fn(async<T>(text:string,values:unknown[]=[])=>Array.from(await tx.unsafe(text,params(text,values))) as T[])) as never};
  async function job(status:string,capability='quiz-learn'){
    const [plan]=await sql`insert into plans(user_id,helper_id,source,capability_id,capability_version,script,label,risk,mutates_course,verifier,confirmed,expires_at) values(${user},${helper},'manual-capability',${capability},1,'pw-learn-quiz.js','Idle fixture','low',true,'process-exit',true,now()+interval '5 minutes') returning id,attempt_id`;
    const [created]=await sql`insert into jobs(user_id,helper_id,plan_id,attempt_id,capability_id,capability_version,script,status,created_at,dispatched_at,started_at) values(${user},${helper},${plan.id},${plan.attempt_id},${capability},1,'pw-learn-quiz.js',${status},now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute') returning id`;
    return created.id;
  }
  try{
    await sql`insert into profiles(id,email) values(${user},${user+'@example.invalid'})`;
    await sql`insert into helpers(id,user_id,device_name,version,status,last_seen_at) values(${helper},${user},'Idle fixture','1.0.14','online',now())`;
    const initial=await operatorActivity(user,helper,'check',deps);
    assert.equal(initial.paused,false);
    assert.equal(Date.parse(initial.expiresAt)-Date.parse(initial.lastActivityAt),1_800_000);
    await sql`update operator_activity set last_activity_at=now()-interval '10 minutes' where user_id=${user}`;
    const check=await operatorActivity(user,helper,'check',deps);
    assert.ok(Date.parse(check.serverNow)-Date.parse(check.lastActivityAt)>=600_000,'polling must not renew activity');
    const human=await operatorActivity(user,helper,'activity',deps);
    assert.ok(Date.parse(human.serverNow)-Date.parse(human.lastActivityAt)<1000);
    const running=await job('running'),queued=await job('queued'),close=await job('queued','close-browser');
    await sql`update helpers set active_job_id=${running},status='busy',last_seen_at=now() where id=${helper}`;
    await sql`update operator_activity set last_activity_at=now()-interval '31 minutes' where user_id=${user}`;
    await enforceOperatorIdle(user,helper,deps);
    const paused=await operatorActivity(user,helper,'check',deps);
    assert.equal(paused.paused,true);
    assert.equal((await sql`select cancel_requested from jobs where id=${running}`)[0].cancel_requested,true);
    assert.equal((await sql`select status from jobs where id=${queued}`)[0].status,'cancelled');
    assert.equal((await sql`select status from jobs where id=${close}`)[0].status,'queued','an explicitly requested browser close must remain possible');
    assert.equal((await operatorActivity(user,helper,'activity',deps)).paused,true,'input after expiry must not silently resume');
    await assert.rejects(deps.transaction(tx=>assertOperatorActive(user,helper,tx)),/session is paused/);
    await enforceOperatorIdle(user,helper,deps);
    assert.equal((await sql`select count(*)::int as n from attempt_events where user_id=${user} and data->>'jobId'=${queued}`)[0].n,1);
    assert.equal((await operatorActivity(user,helper,'resume',deps)).paused,false);
    await deps.transaction(tx=>assertOperatorActive(user,helper,tx));
    await sql`update jobs set status='cancelled',finished_at=now() where user_id=${user}`;
    await sql`update helpers set status='online',active_job_id=null,last_seen_at=now() where id=${helper}`;
    const probes=await Promise.all([reserveBrowserRefresh(user,helper,false,deps),reserveBrowserRefresh(user,helper,false,deps)]);
    assert.equal(probes.filter(Boolean).length,1,'two pages must not queue duplicate automatic probes');
    await operatorActivity(user,helper,'pause',deps);
    await assert.rejects(reserveBrowserRefresh(user,helper,true,deps),/session is paused/);
  }finally{await sql`delete from profiles where id=${user}`;await sql.end();}
});
