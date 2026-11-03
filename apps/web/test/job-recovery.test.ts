import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { jobRecoveryDecision, recoverHelperJobs, requestHelperJobCancellation, readRelevantJob, type RecoveryJob, type RecoveryHelper, type JobRecoveryDeps } from '../src/lib/job-recovery';
import { endOperatorSession } from '../src/lib/operations';

const now = new Date('2026-11-03T12:00:00Z');
const old = new Date(now.getTime() - 3600_000);
const job: RecoveryJob = { id: 'job', user_id: 'user', helper_id: 'helper', attempt_id: 'attempt', capability_id: 'list-tabs', script: 'pw-list-tabs.js', label: 'List tabs', status: 'running', cancel_requested: false, mutates_course: false, created_at: old, dispatched_at: old, started_at: old };
const helper: RecoveryHelper = { id: 'helper', active_job_id: null, last_seen_at: now, revoked_at: null, now };

test('fresh idle helper recovers a crashed job, preserving cancellation', () => {
  assert.equal(jobRecoveryDecision(job, helper)?.status, 'failed');
  assert.equal(jobRecoveryDecision({ ...job, cancel_requested: true }, helper)?.status, 'cancelled');
});
test('healthy long-running jobs are not expired by elapsed runtime', () => {
  assert.equal(jobRecoveryDecision(job, { ...helper, active_job_id: job.id }), null);
});
test('dispatch grace excludes a fresh claim and a heartbeat sampled before it', () => {
  assert.equal(jobRecoveryDecision({ ...job, started_at: now }, helper), null);
  const claim = new Date(now.getTime() - 40_000);
  assert.equal(jobRecoveryDecision({ ...job, dispatched_at: claim, started_at: claim }, { ...helper, last_seen_at: new Date(now.getTime() - 45_000) }), null);
});
test('offline or revoked helpers recover claims; unstarted queued work is retained', () => {
  assert.equal(jobRecoveryDecision(job, { ...helper, last_seen_at: old })?.status, 'helper-offline');
  assert.equal(jobRecoveryDecision(job, { ...helper, revoked_at: now })?.status, 'helper-offline');
  assert.equal(jobRecoveryDecision({ ...job, status: 'queued' }, helper), null);
  assert.equal(jobRecoveryDecision({ ...job, status: 'queued', cancel_requested: true }, helper)?.status, 'cancelled');
  assert.equal(jobRecoveryDecision({ ...job, status: 'completed' }, helper), null);
});

// Opt-in real SQL regression tests: explicitly reject production URLs.
const url = process.env.VITRIOL_RECOVERY_TEST_DATABASE_URL;
test('Postgres: hidden orphan recovery, cancellation, ownership, session ending and idempotency', { skip: !url }, async () => {
  const target = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  assert.ok(target.pathname.startsWith('/vitriol_regression'));
  const sql = postgres(url!, { max: 4, prepare: false });
  const user = `recovery-${randomUUID()}`;
  const helperId = randomUUID();
  // postgres.js JSON-encodes inferred jsonb parameters; match pg/Neon's raw JSON strings.
  function parameters(text: string, values: unknown[]) {
    const json = new Set(Array.from(text.matchAll(/\$(\d+)::jsonb/g), match => Number(match[1]) - 1));
    return values.map((value, index) => json.has(index) && typeof value === 'string' ? JSON.parse(value) : value) as never[];
  }
  const query: JobRecoveryDeps['query'] = async <T>(text: string, values: unknown[] = []) => Array.from(await sql.unsafe(text, parameters(text, values))) as T[];
  const deps: JobRecoveryDeps = { query, transaction: async fn => sql.begin(async tx => fn(async <T>(text: string, values: unknown[] = []) => Array.from(await tx.unsafe(text, parameters(text, values))) as T[])) as never };
  async function makeJob(status: string, mutates = false, capability = 'list-tabs') {
    const id = randomUUID();
    const [plan] = await sql`insert into plans(user_id,helper_id,source,capability_id,capability_version,script,label,risk,mutates_course,verifier,confirmed,expires_at)
      values(${user},${helperId},'direct-readonly',${capability},1,'pw-list-tabs.js','Regression fixture','none',${mutates},'process-exit',true,now()+interval '5 minutes') returning id,attempt_id`;
    await sql`insert into jobs(id,user_id,helper_id,plan_id,attempt_id,capability_id,capability_version,script,status,created_at,dispatched_at,started_at)
      values(${id},${user},${helperId},${plan.id},${plan.attempt_id},${capability},1,'pw-list-tabs.js',${status},now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour')`;
    return id;
  }
  try {
    await sql`insert into profiles(id,email) values(${user},${user + '@example.invalid'})`;
    await sql`insert into helpers(id,user_id,device_name,version,status,last_seen_at) values(${helperId},${user},'Recovery fixture','1.0.14','online',now())`;
    const orphan = await makeJob('running');
    const newer = await makeJob('completed');
    await sql`update jobs set created_at=now() where id=${newer}`;
    assert.equal((await readRelevantJob(user, helperId, query))?.id, orphan);
    assert.deepEqual(await recoverHelperJobs('another-user', helperId, deps), []);
    assert.equal((await sql`select status from jobs where id=${orphan}`)[0].status, 'running');
    await sql`insert into job_events(user_id,job_id,sequence,event,data,occurred_at) values(${user},${orphan},1,'stderr','{"text":"retained crash evidence"}',now())`;
    await Promise.all([recoverHelperJobs(user, helperId, deps), recoverHelperJobs(user, helperId, deps)]);
    assert.equal((await sql`select status from jobs where id=${orphan}`)[0].status, 'failed');
    assert.equal((await sql`select count(*)::int as n from attempt_events where user_id=${user} and data->>'jobId'=${orphan}`)[0].n, 1);
    assert.equal((await sql`select count(*)::int as n from job_events where job_id=${orphan}`)[0].n, 1);
    assert.deepEqual(await recoverHelperJobs(user, helperId, deps), []);
    const healthy = await makeJob('running', true);
    await sql`update helpers set active_job_id=${healthy},status='busy',last_seen_at=now() where id=${helperId}`;
    assert.deepEqual(await recoverHelperJobs(user, helperId, deps), []);
    await assert.rejects(requestHelperJobCancellation({ userId:user, helperId, endSession:true }, deps), /course run is still active/);
    assert.equal((await sql`select cancel_requested from jobs where id=${healthy}`)[0].cancel_requested, false);
    await requestHelperJobCancellation({ userId:user, helperId, endSession:true, forceClose:true }, deps);
    assert.equal((await sql`select cancel_requested from jobs where id=${healthy}`)[0].cancel_requested, true);
    await sql`update helpers set active_job_id=null,status='online',last_seen_at=now() where id=${helperId}`;
    assert.deepEqual(await recoverHelperJobs(user, helperId, deps), [healthy]);
    assert.equal((await sql`select status from jobs where id=${healthy}`)[0].status, 'cancelled');
    const queued = await makeJob('queued', true);
    const close = await makeJob('running', false, 'close-browser');
    await sql`insert into operator_sessions(user_id,helper_id,idempotency_key,status,close_job_id) values(${user},${helperId},${randomUUID()},'ending',${close})`;
    await recoverHelperJobs(user, helperId, deps);
    assert.equal((await sql`select status from operator_sessions where close_job_id=${close}`)[0].status, 'close_failed');
    const key = randomUUID();
    let closes = 0;
    const endDeps = { ...deps, createCloseJob: async () => { closes++; return makeJob('completed', false, 'close-browser'); } };
    const ended = await endOperatorSession({ userId:user, helperId, idempotencyKey:key, forceClose:false }, endDeps);
    assert.equal(ended.status, 'ended');
    assert.equal((await sql`select status from jobs where id=${queued}`)[0].status, 'cancelled');
    assert.deepEqual(await endOperatorSession({ userId:user, helperId, idempotencyKey:key, forceClose:false }, endDeps), ended);
    assert.equal(closes, 1);
    const offline = await makeJob('running');
    await sql`update helpers set last_seen_at=now()-interval '3 minutes',active_job_id=${offline} where id=${helperId}`;
    await recoverHelperJobs(user, helperId, deps);
    assert.equal((await sql`select status from jobs where id=${offline}`)[0].status, 'helper-offline');
    assert.equal((await sql`select active_job_id from helpers where id=${helperId}`)[0].active_job_id, null);
  } finally {
    await sql`delete from profiles where id=${user}`;
    await sql.end();
  }
});
