import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');
const sql = postgres(connectionString, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 15,
  prepare: false,
  ssl: 'require',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(operation, message) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

const userId = `verify-${randomUUID()}`;
try {
  const expectedTables = [
    'profiles',
    'helpers',
    'pairing_codes',
    'plans',
    'jobs',
    'job_events',
    'attempt_events',
    'history_events',
    'strategies',
    'review_items',
    'artifacts',
  ];
  const tables = await sql`
    select tablename from pg_tables
    where schemaname = 'public' and tablename = any(${expectedTables})
  `;
  assert(tables.length === expectedTables.length, 'Control-plane tables are missing.');
  const rls = await sql`
    select relname, relrowsecurity from pg_class where relname = any(${expectedTables})
  `;
  assert(rls.length === expectedTables.length && rls.every((row) => row.relrowsecurity), 'RLS is not enabled on every user-owned table.');
  const policies = await sql`
    select tablename from pg_policies
    where schemaname = 'public' and tablename = any(${expectedTables})
  `;
  assert(new Set(policies.map((row) => row.tablename)).size === expectedTables.length, 'An RLS ownership policy is missing.');

  await sql`insert into profiles (id, email) values (${userId}, ${`${userId}@example.invalid`})`;
  const codeHash = randomUUID().replaceAll('-', '');
  await sql`
    insert into pairing_codes (user_id, code_hash, expires_at)
    values (${userId}, ${codeHash}, now() + interval '5 minutes')
  `;
  const [helper] = await sql`
    select id from claim_pairing_code(${codeHash}, 'CI helper', 'win32', 'x64', '1.0.0')
  `;
  assert(helper?.id, 'Pairing verification failed.');
  await expectFailure(
    () => sql`select id from claim_pairing_code(${codeHash}, 'Replay', 'win32', 'x64', '1.0.0')`,
    'A pairing code was accepted twice.',
  );

  const [unconfirmedPlan] = await sql`
    insert into plans (
      user_id, helper_id, source, capability_id, capability_version, script,
      label, risk, mutates_course, verifier, confirmed, expires_at
    ) values (
      ${userId}, ${helper.id}, 'detected', 'scorm-complete', 1, 'pw-scorm-complete.js',
      'Complete SCORM', 'medium', true, 'scorm-status', false, now() + interval '5 minutes'
    )
    returning id
  `;
  await expectFailure(
    () => sql`select id from consume_plan_and_create_job(${unconfirmedPlan.id}, ${userId}, ${randomUUID()})`,
    'An unconfirmed mutating plan created a job.',
  );
  await sql`update plans set confirmed = true, confirmed_at = now() where id = ${unconfirmedPlan.id}`;
  const jobId = randomUUID();
  const [job] = await sql`
    select id from consume_plan_and_create_job(${unconfirmedPlan.id}, ${userId}, ${jobId})
  `;
  assert(job?.id === jobId, 'Confirmed plan consumption failed.');
  await expectFailure(
    () => sql`select id from consume_plan_and_create_job(${unconfirmedPlan.id}, ${userId}, ${randomUUID()})`,
    'A confirmed plan was consumed twice.',
  );

  await sql`
    insert into job_events (user_id, job_id, sequence, event, occurred_at)
    values (${userId}, ${jobId}, 1, 'accepted', now())
    on conflict (job_id, sequence) do nothing
  `;
  await sql`
    insert into job_events (user_id, job_id, sequence, event, occurred_at)
    values (${userId}, ${jobId}, 1, 'accepted', now())
    on conflict (job_id, sequence) do nothing
  `;
  const [{ count }] = await sql`select count(*)::int as count from job_events where job_id = ${jobId}`;
  assert(count === 1, 'Job event idempotency verification failed.');

  const [claimedJob] = await sql`select id from claim_next_helper_job(${helper.id}, ${userId})`;
  assert(claimedJob?.id === jobId, 'Queued job claim failed.');
  await sql`update jobs set status = 'running', started_at = now() where id = ${jobId}`;
  await sql`update helpers set last_seen_at = now() - interval '3 minutes' where id = ${helper.id}`;
  await sql`select id from claim_next_helper_job(${helper.id}, ${userId})`;
  const [offlineJob] = await sql`select status from jobs where id = ${jobId}`;
  assert(offlineJob.status === 'helper-offline', 'Offline helper recovery did not close a running job.');

  const [cancelledPlan] = await sql`
    insert into plans (
      user_id, helper_id, source, capability_id, capability_version, script,
      label, risk, mutates_course, verifier, confirmed, expires_at
    ) values (
      ${userId}, ${helper.id}, 'direct-readonly', 'list-tabs', 1, 'pw-list-tabs.js',
      'List tabs', 'none', false, 'process-exit', true, now() + interval '5 minutes'
    )
    returning id
  `;
  const cancelledJobId = randomUUID();
  await sql`select id from consume_plan_and_create_job(${cancelledPlan.id}, ${userId}, ${cancelledJobId})`;
  await sql`update jobs set cancel_requested = true where id = ${cancelledJobId}`;
  const cancelledClaim = await sql`select id from claim_next_helper_job(${helper.id}, ${userId})`;
  assert(cancelledClaim.length === 0, 'A cancelled queued job was dispatched.');

  console.log('Neon schema, pairing, confirmation, idempotency, recovery, and cancellation verified.');
} finally {
  await sql`delete from profiles where id = ${userId}`.catch(() => undefined);
  await sql.end();
}
