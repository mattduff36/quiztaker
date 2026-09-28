import {
  assertFreshTarget,
  getCapability,
  type BrowserSessionSnapshot,
  type PlanProposal,
} from '@quiztaker/core';
import { queryOne, queryRows } from '@/lib/db';
import { assertHelperSupports, createPlan, type CreatePlanInput } from '@/lib/plans';

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

export async function endOperatorSession(input: {
  userId: string;
  helperId: string;
  idempotencyKey: string;
  forceClose: boolean;
}): Promise<{ status: string; sessionId: string; closeJobId: string | null }> {
  const existing = await queryOne<{ id: string; status: string; close_job_id: string | null }>(
    `select id, status, close_job_id from operator_sessions
     where user_id = $1 and idempotency_key = $2`,
    [input.userId, input.idempotencyKey],
  );
  if (existing && !['open', 'close_failed'].includes(existing.status)) {
    return { status: existing.status, sessionId: existing.id, closeJobId: existing.close_job_id };
  }
  const active = await queryOne<{ id: string }>(
    `select jobs.id
     from jobs
     join plans on plans.id = jobs.plan_id
     where jobs.user_id = $1 and jobs.helper_id = $2
       and jobs.status in ('queued', 'dispatched', 'running')
       and plans.mutates_course = true`,
    [input.userId, input.helperId],
  );
  if (active && !input.forceClose) {
    throw new Error('A course run is still active. Confirm a separate browser close.');
  }
  const since = await queryOne<{ started_at: string }>(
    `select ended_at as started_at from operator_sessions
     where user_id = $1 and status = 'ended'
     order by ended_at desc limit 1`,
    [input.userId],
  );
  const rows = await queryRows<{ kind: string; title: string; result: string; detail: string }>(
    `select kind, title, result, detail from history_events
     where user_id = $1 and occurred_at > coalesce($2::timestamptz, '-infinity'::timestamptz)
     order by occurred_at desc limit 200`,
    [input.userId, since?.started_at ?? null],
  );
  const needsReview = rows.filter((row) => /review|fail|block/i.test(`${row.result} ${row.detail}`));
  const session = existing ?? await queryOne<{ id: string; status: string; close_job_id: string | null }>(
    `insert into operator_sessions (user_id, helper_id, idempotency_key, status, recap, needs_review)
     values ($1, $2, $3, 'open', $4::jsonb, $5::jsonb)
     returning id, status, close_job_id`,
    [
      input.userId,
      input.helperId,
      input.idempotencyKey,
      JSON.stringify({ items: rows.length, courses: rows.filter((row) => row.kind === 'course').length, activities: rows.filter((row) => row.kind === 'activity').length }),
      JSON.stringify(needsReview),
    ],
  );
  if (!session) throw new Error('Could not record the session');
  await queryRows(
    `update operator_sessions set status = 'ending', recap = $2::jsonb, needs_review = $3::jsonb where id = $1`,
    [
      session.id,
      JSON.stringify({ items: rows.length, courses: rows.filter((row) => row.kind === 'course').length, activities: rows.filter((row) => row.kind === 'activity').length }),
      JSON.stringify(needsReview),
    ],
  );
  let closeJobId: string | null = null;
  try {
    const plan = await createCapabilityPlan(input.userId, {
      helperId: input.helperId,
      capabilityId: 'close-browser',
      capabilityInput: { capabilityId: 'close-browser' },
      source: 'manual-capability',
      label: 'Close CDP browser',
    });
    const confirmed = await queryOne<{ id: string }>(
      `update plans set confirmed = true, confirmed_at = now()
       where id = $1 and user_id = $2 returning id`,
      [plan.planId, input.userId],
    );
    if (!confirmed) throw new Error('Could not confirm browser close');
    const { createJob } = await import('@/lib/jobs');
    closeJobId = (await createJob(input.userId, plan.planId)).jobId;
    await queryRows(
      `update operator_sessions
       set close_job_id = $2, recap = recap || $3::jsonb
       where id = $1 and status = 'ending'`,
      [session.id, closeJobId, JSON.stringify({ closeQueued: true })],
    );
    return { status: 'ending', sessionId: session.id, closeJobId };
  } catch (error) {
    await queryRows(
      `update operator_sessions set status = 'close_failed', recap = recap || $2::jsonb where id = $1`,
      [session.id, JSON.stringify({ error: error instanceof Error ? error.message : 'close failed' })],
    );
    return { status: 'close_failed', sessionId: session.id, closeJobId };
  }
}
