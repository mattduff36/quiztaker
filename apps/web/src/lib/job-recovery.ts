import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';
import { retryDatabaseConflict } from '@/lib/database-retry';

export const ORPHAN_GRACE_MS = 30_000;
export const HELPER_OFFLINE_MS = 120_000;

export interface JobRecoveryDeps {
  query: SqlQuery;
  transaction: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>;
}

export const jobRecoveryDatabase: JobRecoveryDeps = { query: queryRows, transaction: withTransaction };

export interface RecoveryJob {
  id: string;
  user_id: string;
  helper_id: string;
  attempt_id: string;
  capability_id: string;
  script: string;
  label: string | null;
  status: string;
  cancel_requested: boolean;
  mutates_course: boolean;
  created_at: string | Date;
  dispatched_at: string | Date | null;
  started_at: string | Date | null;
}

export interface RecoveryHelper {
  id: string;
  active_job_id: string | null;
  last_seen_at: string | Date | null;
  revoked_at: string | Date | null;
  now: string | Date;
}

interface RecoveryDecision {
  status: 'failed' | 'cancelled' | 'helper-offline';
  reason: 'helper-job-orphaned' | 'helper-offline' | 'cancelled-before-dispatch';
}

export function isTerminalJobStatus(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'helper-offline', 'awaiting-input'].includes(status);
}

export function jobRecoveryDecision(job: RecoveryJob, helper: RecoveryHelper): RecoveryDecision | null {
  if (job.status === 'queued') {
    return job.cancel_requested ? { status: 'cancelled', reason: 'cancelled-before-dispatch' } : null;
  }
  if (!['dispatched', 'running'].includes(job.status)) return null;
  const now = new Date(helper.now).getTime();
  const claimedAt = Math.max(
    new Date(job.dispatched_at ?? job.created_at).getTime(),
    new Date(job.started_at ?? job.dispatched_at ?? job.created_at).getTime(),
  );
  if (now - claimedAt < ORPHAN_GRACE_MS) return null;
  const lastSeen = helper.last_seen_at == null ? null : new Date(helper.last_seen_at).getTime();
  const offline = helper.revoked_at != null || lastSeen == null || now - lastSeen >= HELPER_OFFLINE_MS;
  if (offline) return { status: job.cancel_requested ? 'cancelled' : 'helper-offline', reason: 'helper-offline' };
  // A heartbeat sampled just before a claim/start cannot prove that claim was lost.
  if (helper.active_job_id === job.id || lastSeen! - claimedAt < ORPHAN_GRACE_MS) return null;
  return { status: job.cancel_requested ? 'cancelled' : 'failed', reason: 'helper-job-orphaned' };
}

export const jobRecoverySql = {
  lockJobs: `select jobs.id, jobs.user_id, jobs.helper_id, jobs.attempt_id, jobs.capability_id,
       jobs.script, jobs.status, jobs.cancel_requested, jobs.created_at, jobs.dispatched_at,
       jobs.started_at, plans.label, plans.mutates_course
     from jobs join plans on plans.id = jobs.plan_id
     where jobs.user_id = $1 and jobs.helper_id = $2
       and jobs.status in ('queued', 'dispatched', 'running')
     order by jobs.id
     for no key update of jobs`,
  lockHelper: `select id, active_job_id, last_seen_at, revoked_at, clock_timestamp() as now
     from helpers where user_id = $1 and id = $2 for no key update`,
  requestCancel: `update jobs set cancel_requested = true
     where id = $1 and user_id = $2 and helper_id = $3
       and status in ('queued', 'dispatched', 'running')`,
  finish: `update jobs set status = $4, finished_at = $5, outcome = $6::jsonb, diagnosis = $7::jsonb
     where id = $1 and user_id = $2 and helper_id = $3
       and status in ('queued', 'dispatched', 'running')
     returning id`,
  clearHelper: `update helpers
     set active_job_id = null,
         status = case when revoked_at is not null then 'revoked' when $4 then 'offline' else 'online' end
     where id = $1 and user_id = $2 and active_job_id = $3`,
  attempt: `insert into attempt_events (user_id, attempt_id, event, data, occurred_at)
     select $1, $2, 'attempt-finished', $3::jsonb, $4
     where not exists (
       select 1 from attempt_events where user_id = $1 and attempt_id = $2
         and event = 'attempt-finished' and data->>'jobId' = $5
     )`,
  history: `insert into history_events (
       user_id, helper_id, source_id, kind, title, result, detail, occurred_at, payload
     ) values ($1, $2, $3, 'automation', $4, $5, $6, $7, $8::jsonb)
     on conflict (user_id, helper_id, source_id) do nothing`,
  failClose: `update operator_sessions
     set status = 'close_failed', recap = recap || $4::jsonb
     where user_id = $1 and helper_id = $2 and close_job_id = $3 and status = 'ending'`,
  relevantJob: `select id, status, capability_id, input, outcome, diagnosis, result, output_url
     from jobs where user_id = $1 and helper_id = $2
     order by case when status in ('dispatched', 'running') then 0 when status = 'queued' then 1 else 2 end,
       created_at desc, id desc limit 1`,
} as const;

export async function readRelevantJob(userId: string, helperId: string, query: SqlQuery = queryRows) {
  return (await query<Record<string, unknown>>(jobRecoverySql.relevantJob, [userId, helperId]))[0] ?? null;
}

export async function recoverHelperJobs(
  userId: string,
  helperId: string,
  deps: JobRecoveryDeps = jobRecoveryDatabase,
): Promise<string[]> {
  return reconcileHelperJobs({ userId, helperId }, deps);
}

export async function requestHelperJobCancellation(input: {
  userId: string;
  helperId: string;
  jobId?: string;
  endSession?: boolean;
  forceClose?: boolean;
  excludeCapabilities?: string[];
}, deps: JobRecoveryDeps = jobRecoveryDatabase): Promise<number> {
  let requested = 0;
  await reconcileHelperJobs(input, deps, (jobs, helper) => {
    if (input.endSession && !input.forceClose && jobs.some((job) => (
      job.mutates_course && ['dispatched', 'running'].includes(job.status) && !jobRecoveryDecision(job, helper)
    ))) {
      throw new Error('A course run is still active. Confirm a separate browser close.');
    }
    const targets = jobs.filter((job) => (!input.jobId || job.id === input.jobId) && !input.excludeCapabilities?.includes(job.capability_id));
    requested = targets.length;
    return targets;
  });
  return requested;
}

async function reconcileHelperJobs(
  scope: { userId: string; helperId: string },
  deps: JobRecoveryDeps,
  cancellation?: (jobs: RecoveryJob[], helper: RecoveryHelper) => RecoveryJob[],
): Promise<string[]> {
  return retryDatabaseConflict(() => deps.transaction(async (sql) => {
    // Terminal events take jobs before helpers too. NO KEY UPDATE permits heartbeat's FK check.
    const jobs = await sql<RecoveryJob>(jobRecoverySql.lockJobs, [scope.userId, scope.helperId]);
    const [helper] = await sql<RecoveryHelper>(jobRecoverySql.lockHelper, [scope.userId, scope.helperId]);
    if (!helper) return [];
    for (const job of cancellation?.(jobs, helper) ?? []) {
      await sql(jobRecoverySql.requestCancel, [job.id, scope.userId, scope.helperId]);
      job.cancel_requested = true;
    }
    const recovered: string[] = [];
    for (const job of jobs) {
      const decision = jobRecoveryDecision(job, helper);
      if (!decision) continue;
      if (await finishRecoveredJob(sql, job, helper, decision)) recovered.push(job.id);
    }
    return recovered;
  }));
}

async function finishRecoveredJob(
  sql: SqlQuery,
  job: RecoveryJob,
  helper: RecoveryHelper,
  decision: RecoveryDecision,
): Promise<boolean> {
  const detail = decision.reason === 'cancelled-before-dispatch'
    ? 'Cancelled before dispatch; no work was started.'
    : decision.reason === 'helper-offline'
      ? 'The helper stopped sending heartbeats. Completion could not be verified; the job will not be replayed.'
      : 'A fresh helper heartbeat no longer owns this job. Completion could not be verified; the job will not be replayed.';
  const recommendation = 'Review the retained output and refresh browser/course status before explicitly starting another run.';
  const outcome = {
    outcome: decision.status === 'cancelled' ? 'cancelled' : 'failure',
    verified: false,
    status: decision.status === 'cancelled' ? decision.reason === 'cancelled-before-dispatch' ? decision.reason : 'cancelled' : decision.reason,
    failureSignature: decision.reason,
  };
  const diagnosis = decision.status === 'cancelled' ? null : {
    schemaVersion: 1,
    severity: 'error',
    title: 'Helper job recovered without completion evidence',
    completed: null,
    total: null,
    likelyCause: { code: decision.reason, label: 'Helper lost the job', confidence: 1, explanation: detail, recommendation },
    evidence: [detail],
    affectedTargets: [],
    recommendations: [recommendation],
    artifacts: [],
  };
  const at = new Date(helper.now).toISOString();
  const [updated] = await sql(jobRecoverySql.finish, [
    job.id, job.user_id, job.helper_id, decision.status, at, JSON.stringify(outcome),
    diagnosis == null ? null : JSON.stringify(diagnosis),
  ]);
  if (!updated) return false;
  await sql(jobRecoverySql.clearHelper, [job.helper_id, job.user_id, job.id, decision.reason === 'helper-offline']);
  const evidence = { ...outcome, diagnosis, jobId: job.id, recovery: { reason: decision.reason, detail } };
  await sql(jobRecoverySql.attempt, [job.user_id, job.attempt_id, JSON.stringify(evidence), at, job.id]);
  await sql(jobRecoverySql.history, [
    job.user_id, job.helper_id, `job:${job.id}`, job.label || job.script, outcome.status, detail, at, JSON.stringify(evidence),
  ]);
  if (job.capability_id === 'close-browser') {
    await sql(jobRecoverySql.failClose, [job.user_id, job.helper_id, job.id, JSON.stringify({ error: detail, closeQueued: false })]);
  }
  return true;
}
