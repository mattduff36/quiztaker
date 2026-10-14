import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { TERMINAL_JOB_LOCK_SQL } from '../src/lib/job-lock';

// Opt-in integration test against a disposable local database, never DATABASE_URL.
const url = process.env.VITRIOL_LOCK_TEST_DATABASE_URL;
test('terminal events serialize while heartbeat can check the job foreign key', { skip: !url }, async () => {
  const target = new URL(url!);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.ok(target.pathname.startsWith('/vitriol_regression'));
  const sql = postgres(url!, { max: 2, prepare: false });
  const schema = `lock_test_${Date.now()}`;
  const helperId = '00000000-0000-4000-8000-000000000001';
  const jobId = '00000000-0000-4000-8000-000000000002';
  let a: Awaited<ReturnType<typeof sql.reserve>> | undefined;
  let b: Awaited<ReturnType<typeof sql.reserve>> | undefined;
  try {
    await sql.unsafe(`create schema ${schema}`);
    a = await sql.reserve();
    b = await sql.reserve();
    for (const connection of [a, b]) {
      await connection.unsafe(`set search_path to ${schema}`);
      await connection.unsafe("set lock_timeout = '500ms'");
    }
    await a.unsafe('create table helpers (id uuid primary key, active_job_id uuid, status text)');
    await a.unsafe('create table jobs (id uuid primary key, helper_id uuid references helpers(id), user_id text, status text)');
    await a.unsafe('alter table helpers add foreign key (active_job_id) references jobs(id)');
    await a.unsafe("insert into helpers values ($1, null, 'busy')", [helperId]);
    await a.unsafe("insert into jobs values ($1, $2, 'test-user', 'running')", [jobId, helperId]);

    // Reproduce the old lock conflict that forms one edge of the production deadlock.
    await a.unsafe('begin');
    await a.unsafe('select id from jobs where id = $1 for update', [jobId]);
    await assert.rejects(
      b.unsafe('update helpers set active_job_id = $1 where id = $2', [jobId, helperId]),
      (error: unknown) => (error as { code?: string }).code === '55P03',
    );
    await a.unsafe('rollback');

    // Actual application lock: the heartbeat succeeds before completion releases it.
    await a.unsafe('begin');
    const locked = await a.unsafe(TERMINAL_JOB_LOCK_SQL, [jobId, helperId, 'test-user']);
    assert.equal(locked[0]?.status, 'running');
    await b.unsafe('update helpers set active_job_id = $1 where id = $2', [jobId, helperId]);
    // A second terminal writer must still wait, preserving event idempotency.
    await assert.rejects(
      b.unsafe(TERMINAL_JOB_LOCK_SQL, [jobId, helperId, 'test-user']),
      (error: unknown) => (error as { code?: string }).code === '55P03',
    );
    await a.unsafe("update jobs set status = 'failed' where id = $1", [jobId]);
    await a.unsafe("update helpers set active_job_id = null, status = 'online' where id = $1", [helperId]);
    await a.unsafe('commit');
    assert.equal((await b.unsafe(TERMINAL_JOB_LOCK_SQL, [jobId, helperId, 'test-user']))[0]?.status, 'failed');
    assert.equal((await b.unsafe(TERMINAL_JOB_LOCK_SQL, [jobId, helperId, 'other-user'])).length, 0);
  } finally {
    if (a) { await a.unsafe('rollback').catch(() => {}); a.release(); }
    if (b) { await b.unsafe('rollback').catch(() => {}); b.release(); }
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  }
});
