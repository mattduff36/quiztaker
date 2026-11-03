import {
  assertFreshTarget,
  getCapability,
  type BrowserSessionSnapshot,
  type PlanProposal,
} from '@quiztaker/core';
import { queryOne, queryRows } from '@/lib/db';
import { assertHelperSupports, createPlan, type CreatePlanInput } from '@/lib/plans';
import {
  isTerminalJobStatus,
  jobRecoveryDatabase,
  recoverHelperJobs,
  requestHelperJobCancellation,
  type JobRecoveryDeps,
} from '@/lib/job-recovery';

export interface StoredSession {
  id: string;
  revision: number;
  cdp_connected: boolean;
  tabs: BrowserSessionSnapshot['tabs'];
  roster: Record<string, unknown> | null;
  detection: Record<string, unknown> | null;
}

export async function latestSession(userId: string, helperId: string): Promise<StoredSession | null> {
  return queryOne<StoredSession>(
    `select id, revision, cdp_connected, tabs, roster, detection
     from browser_sessions
     where user_id = $1 and helper_id = $2 and closed_at is null
     order by updated_at desc
     limit 1`,
    [userId, helperId],
  );
}

export async function createCapabilityPlan(
  userId: string,
  input: CreatePlanInput & { capabilityInput?: Record<string, unknown> },
): Promise<PlanProposal> {
  const capability = getCapability(input.capabilityId);
  if (!capability) throw new Error('Unknown capability');
  await assertHelperSupports(userId, input.helperId, capability.id, capability.version);
  if (input.capabilityInput?.target) {
    const session = await latestSession(userId, input.helperId);
    if (!session) throw new Error('Browser target is stale');
    assertFreshTarget(input.capabilityInput, {
      id: session.id,
      revision: session.revision,
      tabs: session.tabs ?? [],
    });
  }
  if (input.capabilityId === 'cert-batch' || input.capabilityId === 'class-batch') {
    const titles = input.capabilityInput?.titles;
    const session = await latestSession(userId, input.helperId);
    const roster = session?.roster as { courses?: Array<{ title?: string; isBlocked?: boolean }>; activities?: Array<{ title?: string; isBlocked?: boolean }> } | null;
    const known = new Set([
      ...(roster?.courses ?? []),
      ...(roster?.activities ?? []),
    ].filter((item) => !item.isBlocked).map((item) => item.title));
    if (!Array.isArray(titles) || titles.some((title) => !known.has(String(title)))) {
      throw new Error('Select items from the current roster');
    }
  }
  return createPlan(userId, input);
}

export async function forgetRecentUrl(userId: string, url: string): Promise<void> {
  await queryRows(
    `update recent_urls set forgotten_at = now()
     where user_id = $1 and url = $2 and forgotten_at is null`,
    [userId, url],
  );
}

export interface EndSessionDeps extends JobRecoveryDeps {
  createCloseJob: (userId: string, helperId: string) => Promise<string>;
}

export async function endOperatorSession(input: {
  userId: string;
  helperId: string;
  idempotencyKey: string;
  forceClose: boolean;
}, deps: EndSessionDeps = { ...jobRecoveryDatabase, createCloseJob }): Promise<{ status: string; sessionId: string; closeJobId: string | null }> {
  await recoverHelperJobs(input.userId, input.helperId, deps);
  const [existing] = await deps.query<{ id: string; status: string; close_job_id: string | null }>(
    `select id, status, close_job_id from operator_sessions
     where user_id = $1 and idempotency_key = $2`,
    [input.userId, input.idempotencyKey],
  );
  if (existing && !['open', 'close_failed'].includes(existing.status)) {
    return { status: existing.status, sessionId: existing.id, closeJobId: existing.close_job_id };
  }
  await requestHelperJobCancellation({ ...input, endSession: true }, deps);
  const [since] = await deps.query<{ started_at: string }>(
    `select ended_at as started_at from operator_sessions
     where user_id = $1 and status = 'ended'
     order by ended_at desc limit 1`,
    [input.userId],
  );
  const rows = await deps.query<{ kind: string; title: string; result: string; detail: string }>(
    `select kind, title, result, detail from history_events
     where user_id = $1 and occurred_at > coalesce($2::timestamptz, '-infinity'::timestamptz)
     order by occurred_at desc limit 200`,
    [input.userId, since?.started_at ?? null],
  );
  const needsReview = rows.filter((row) => /review|fail|block/i.test(`${row.result} ${row.detail}`));
  const recap = JSON.stringify({ items: rows.length, courses: rows.filter((row) => row.kind === 'course').length, activities: rows.filter((row) => row.kind === 'activity').length });
  const session = existing ?? (await deps.query<{ id: string; status: string; close_job_id: string | null }>(
    `insert into operator_sessions (user_id, helper_id, idempotency_key, status, recap, needs_review)
     values ($1, $2, $3, 'open', $4::jsonb, $5::jsonb)
     returning id, status, close_job_id`,
    [input.userId, input.helperId, input.idempotencyKey, recap, JSON.stringify(needsReview)],
  ))[0];
  if (!session) throw new Error('Could not record the session');
  await deps.query(
    `update operator_sessions set status = 'ending', recap = $2::jsonb, needs_review = $3::jsonb where id = $1`,
    [session.id, recap, JSON.stringify(needsReview)],
  );
  let closeJobId: string | null = null;
  try {
    closeJobId = await deps.createCloseJob(input.userId, input.helperId);
    const status = await deps.transaction(async (sql) => {
      // A fast terminal event/recovery must not finish before the session links its close job.
      const [job] = await sql<{ status: string; finished_at: string | null }>(
        `select status, finished_at from jobs
         where id = $1 and user_id = $2 and helper_id = $3 for no key update`,
        [closeJobId, input.userId, input.helperId],
      );
      if (!job) throw new Error('Browser close job not found');
      const status = job.status === 'completed' ? 'ended' : isTerminalJobStatus(job.status) ? 'close_failed' : 'ending';
      await sql(
        `update operator_sessions
         set close_job_id = $2, status = $3, ended_at = $4, recap = recap || $5::jsonb
         where id = $1 and status = 'ending'`,
        [session.id, closeJobId, status, status === 'ended' ? job.finished_at : null, JSON.stringify({ closeQueued: status === 'ending' })],
      );
      return status;
    });
    return { status, sessionId: session.id, closeJobId };
  } catch (error) {
    await deps.query(
      `update operator_sessions set status = 'close_failed', recap = recap || $2::jsonb where id = $1`,
      [session.id, JSON.stringify({ error: error instanceof Error ? error.message : 'close failed' })],
    );
    return { status: 'close_failed', sessionId: session.id, closeJobId };
  }
}

async function createCloseJob(userId: string, helperId: string): Promise<string> {
  const plan = await createCapabilityPlan(userId, {
    helperId,
    capabilityId: 'close-browser',
    capabilityInput: { capabilityId: 'close-browser' },
    source: 'manual-capability',
    label: 'Close CDP browser',
  });
  const confirmed = await queryOne<{ id: string }>(
    `update plans set confirmed = true, confirmed_at = now()
     where id = $1 and user_id = $2 returning id`,
    [plan.planId, userId],
  );
  if (!confirmed) throw new Error('Could not confirm browser close');
  const { createJob } = await import('@/lib/jobs');
  return (await createJob(userId, plan.planId)).jobId;
}
