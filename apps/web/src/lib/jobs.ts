import { createHash, randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import {
  authorizeRun,
  classifyOutcome,
  deriveHelperSecret,
  diagnoseRun,
  getCapability,
  signJob,
  type JobEnvelope,
  type JobEventInput,
} from '@quiztaker/core';
import { queryOne, queryRows, withTransaction, type SqlQuery } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import { applyStructuredResult } from '@/lib/parity-state';
import { nextStrategyState } from '@/lib/strategy-state';
import { mapPlan } from '@/lib/plans';

interface JobRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  helper_id: string;
  plan_id: string;
  attempt_id: string;
  capability_id: string;
  capability_version: number;
  script: string;
  args: string[];
  fingerprint: string | null;
  nonce: string;
  status: string;
  input?: Record<string, unknown>;
}

export async function createJob(userId: string, planId: string): Promise<{ jobId: string }> {
  let rawPlan = await queryOne<Record<string, unknown>>(
    'select * from plans where id = $1 and user_id = $2',
    [planId, userId],
  );
  if (!rawPlan) throw new Error('Plan not found');
  let plan = mapPlan(rawPlan);
  const capability = getCapability(plan.capabilityId);
  if (capability && !capability.requiresConfirmation && !plan.confirmed) {
    rawPlan = await queryOne<Record<string, unknown>>(
      `update plans
       set confirmed = true, confirmed_at = now()
       where id = $1 and user_id = $2 and consumed = false
       returning *`,
      [planId, userId],
    );
    if (!rawPlan) throw new Error('Plan was already consumed');
    plan = mapPlan(rawPlan);
  }
  const authorization = authorizeRun({ script: plan.script, args: plan.args, plan });
  if (!authorization.ok) throw new Error(authorization.error || 'Run is not authorized');

  const jobId = randomUUID();
  await queryOne<JobRow>(
    'select * from consume_plan_and_create_job($1::uuid, $2::text, $3::uuid)',
    [planId, userId, jobId],
  );
  await queryRows(
    `insert into attempt_events (user_id, attempt_id, event, data)
     values ($1, $2, 'step', $3::jsonb)`,
    [userId, plan.attemptId, JSON.stringify({ step: 'job-queued', jobId })],
  );
  return { jobId };
}

export async function claimNextJob(helperId: string, userId: string): Promise<JobEnvelope | null> {
  const claimed = await queryOne<JobRow>(
    'select * from claim_next_helper_job($1::uuid, $2::text)',
    [helperId, userId],
  );
  if (!claimed) return null;
  const now = new Date();
  const payload = {
    jobId: String(claimed.id),
    planId: String(claimed.plan_id),
    attemptId: String(claimed.attempt_id),
    helperId,
    capabilityId: String(claimed.capability_id),
    capabilityVersion: Number(claimed.capability_version),
    script: String(claimed.script),
    args: claimed.args,
    fingerprint: claimed.fingerprint,
    ...(claimed.input?.capabilityId ? { input: claimed.input } : {}),
    nonce: String(claimed.nonce),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };
  return signJob(payload, deriveHelperSecret(getServerEnv().HELPER_MASTER_KEY, helperId));
}

export async function recordJobEvent(
  helperId: string,
  userId: string,
  jobId: string,
  input: JobEventInput,
): Promise<void> {
  const job = await queryOne<JobRow>(
    'select * from jobs where id = $1 and helper_id = $2 and user_id = $3',
    [jobId, helperId, userId],
  );
  if (!job) throw new Error('Job not found');
  if (['completed', 'failed', 'cancelled', 'helper-offline'].includes(job.status)) return;

  const eventData = { ...input.data };
  let output = typeof eventData.output === 'string' ? eventData.output : '';
  delete eventData.output;
  const isOutputEvent = input.event === 'stdout' || input.event === 'stderr';
  const text = isOutputEvent ? String(eventData.text ?? '') : '';
  if (isOutputEvent) {
    eventData.text = text.slice(0, 2_048);
    eventData.bytes = Buffer.byteLength(text);
    eventData.truncated = text.length > 2_048;
  }
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(input.event);
  if (!isTerminal) {
    if (!isOutputEvent || input.sequence <= 202) {
      const inserted = await queryOne<{ id: number }>(
        `insert into job_events (user_id, job_id, sequence, event, data, occurred_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (job_id, sequence) do nothing
         returning id`,
        [userId, jobId, input.sequence, input.event, JSON.stringify(eventData), input.occurredAt],
      );
      if (!inserted) return;
    }
    if (input.event === 'started') {
      await queryRows(
        `update jobs
         set status = 'running', started_at = $2
         where id = $1 and status = 'dispatched'`,
        [jobId, input.occurredAt],
      );
    }
    return;
  }

  if (!output) {
    const chunks = await queryRows<{ data: { text?: string } }>(
      `select data from job_events
       where job_id = $1 and event in ('stdout', 'stderr')
       order by sequence`,
      [jobId],
    );
    output = chunks.map((row) => String(row.data?.text ?? '')).join('');
  }
  const code = input.event === 'cancelled' ? null : Number(input.data.code ?? 1);
  const outcome = input.event === 'cancelled'
    ? { outcome: 'cancelled' as const, verified: false, status: 'cancelled' }
    : classifyOutcome({ script: job.script, code, output });
  const diagnosis = diagnoseRun({ script: job.script, code, output, outcome });
  const status = input.event === 'completed' && outcome.outcome === 'success' && outcome.verified
    ? 'completed'
    : input.event === 'cancelled' ? 'cancelled' : 'failed';
  const plan = await queryOne<{ label: string; targets: Array<{ id?: string; title: string }> }>(
    'select label, targets from plans where id = $1',
    [job.plan_id],
  );
  const probeOnly = ['list-tabs', 'cdp-check', 'cert-status', 'detect', 'cert-dry-run', 'tab-inspect', 'fit-tab', 'start-browser', 'close-browser', 'open-url', 'learn-capture'].includes(job.capability_id);
  await withTransaction(async (sql) => {
  const locked = await sql<{ status: string }>(
    'select status from jobs where id = $1 and helper_id = $2 and user_id = $3 for update',
    [jobId, helperId, userId],
  );
  if (!locked[0] || ['completed', 'failed', 'cancelled', 'helper-offline'].includes(locked[0].status)) return;
  const artifact = await storeJobOutput(userId, jobId, output);
  await sql(
    `insert into job_events (user_id, job_id, sequence, event, data, occurred_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (job_id, sequence) do nothing`,
    [userId, jobId, input.sequence, input.event, JSON.stringify(eventData), input.occurredAt],
  );
  await sql(
    `update jobs
     set status = $2, exit_code = $3, outcome = $4::jsonb, diagnosis = $5::jsonb,
         output_url = $6, finished_at = $7
     where id = $1 and status not in ('completed', 'failed', 'cancelled', 'helper-offline')`,
    [
      jobId,
      status,
      code,
      JSON.stringify(outcome),
      diagnosis == null ? null : JSON.stringify(diagnosis),
      artifact?.url ?? null,
      input.occurredAt,
    ],
  );
  await sql(
    `update helpers set status = 'online', active_job_id = null where id = $1`,
    [helperId],
  );
  await sql(
    `insert into attempt_events (user_id, attempt_id, event, data, occurred_at)
     select $1, $2, 'attempt-finished', $3::jsonb, $4
     where not exists (
       select 1 from attempt_events
       where user_id = $1 and attempt_id = $2 and event = 'attempt-finished'
         and data->>'jobId' = $5
     )`,
    [userId, job.attempt_id, JSON.stringify({ ...outcome, diagnosis, jobId }), input.occurredAt, jobId],
  );
  await sql(
    `insert into history_events (
       user_id, helper_id, source_id, kind, title, result, detail, occurred_at, payload
     ) values ($1, $2, $3, 'automation', $4, $5, $6, $7, $8::jsonb)
     on conflict (user_id, helper_id, source_id) do update set
       result = excluded.result,
       detail = excluded.detail,
       payload = excluded.payload`,
    [
      userId,
      helperId,
      `job:${jobId}`,
      plan?.label || job.script,
      outcome.status,
      outcome.verified ? 'Verified by the configured completion signal.' : 'Completion was not verified.',
      input.occurredAt,
      JSON.stringify({ jobId, outcome, diagnosis }),
    ],
  );
  if (artifact) {
    await sql(
      `insert into artifacts (
         user_id, helper_id, job_id, storage_url, pathname, media_type, size_bytes, sha256
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (storage_url) do update set
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256`,
      [userId, helperId, jobId, artifact.url, artifact.pathname, 'text/plain; charset=utf-8', artifact.size, artifact.hash],
    );
  }
  if (input.data.result && typeof input.data.result === 'object') {
    await sql(
      'update jobs set result = $2::jsonb where id = $1',
      [jobId, JSON.stringify(input.data.result)],
    );
    await applyStructuredResult({
      userId,
      helperId,
      jobId,
      capabilityId: job.capability_id,
      result: input.data.result as Record<string, unknown>,
    }, sql);
  }
  if (job.capability_id === 'close-browser') {
    await sql(
      `update operator_sessions
       set status = $2, ended_at = $3
       where close_job_id = $1 and status = 'ending'`,
      [jobId, status === 'completed' ? 'ended' : 'close_failed', input.occurredAt],
    );
  }
  if (!probeOnly) {
    await queueStrategyEvidence(sql, {
      userId,
      attemptId: job.attempt_id,
      capabilityId: job.capability_id,
      capabilityVersion: job.capability_version,
      fingerprint: job.fingerprint,
      targets: plan?.targets ?? [],
      verified: outcome.verified,
      failureSignature: outcome.failureSignature,
      diagnosis,
    });
  }
  });
}

async function storeJobOutput(
  userId: string,
  jobId: string,
  output: string,
): Promise<{ url: string; pathname: string; hash: string; size: number } | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const pathname = `${userId}/${jobId}/output.txt`;
    const blob = await put(pathname, output, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'text/plain; charset=utf-8',
    });
    return {
      url: blob.url,
      pathname: blob.pathname,
      hash: createHash('sha256').update(output).digest('hex'),
      size: Buffer.byteLength(output),
    };
  } catch {
    return null;
  }
}

async function queueStrategyEvidence(sql: SqlQuery, input: {
  userId: string;
  attemptId: string;
  capabilityId: string;
  capabilityVersion: number;
  fingerprint: string | null;
  targets: Array<{ id?: string; title: string }>;
  verified: boolean;
  failureSignature?: string;
  diagnosis: unknown;
}): Promise<void> {
  await sql(
    'select pg_advisory_xact_lock(hashtext($1))',
    [`${input.userId}:${input.capabilityId}:${input.capabilityVersion}:${input.fingerprint ?? ''}`],
  );
  const existingRows = await sql<Record<string, unknown>>(
    `select * from strategies
     where user_id = $1 and capability_id = $2 and capability_version = $3
       and fingerprint is not distinct from $4
     for update`,
    [input.userId, input.capabilityId, input.capabilityVersion, input.fingerprint],
  );
  const existing = existingRows[0];
  const priorEvidence = (existing?.evidence as { successAttemptIds?: string[]; failureAttemptIds?: string[]; lastSuccessAt?: string; lastFailureAt?: string } | null) ?? {};
  const next = nextStrategyState(existing ? {
    successes: Number(existing.successes || 0),
    failures: Number(existing.failures || 0),
    status: String(existing.status || 'candidate'),
    targets: (existing.targets as string[] | null) ?? [],
    evidence: {
      successAttemptIds: priorEvidence.successAttemptIds ?? [],
      failureAttemptIds: priorEvidence.failureAttemptIds ?? [],
      lastSuccessAt: priorEvidence.lastSuccessAt,
      lastFailureAt: priorEvidence.lastFailureAt,
    },
  } : null, {
    attemptId: input.attemptId,
    verified: input.verified,
    targets: input.targets.map((target) => target.id || target.title),
    at: new Date().toISOString(),
  });
  const { successes, failures, status, targets: targetValues, evidence } = next;
  await sql(
    `insert into strategies (
       user_id, capability_id, capability_version, fingerprint, status,
       successes, failures, targets, actions, last_failure_signature, evidence, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, now())
     on conflict (user_id, capability_id, capability_version, fingerprint)
     do update set
       status = excluded.status,
       successes = excluded.successes,
       failures = excluded.failures,
       targets = excluded.targets,
       last_failure_signature = excluded.last_failure_signature,
       evidence = excluded.evidence,
       revision = strategies.revision + 1,
       updated_at = now()
     where not (
       jsonb_exists(coalesce(strategies.evidence->'successAttemptIds', '[]'::jsonb), $12)
       or jsonb_exists(coalesce(strategies.evidence->'failureAttemptIds', '[]'::jsonb), $12)
     )`,
    [
      input.userId,
      input.capabilityId,
      input.capabilityVersion,
      input.fingerprint,
      status,
      successes,
      failures,
      JSON.stringify(targetValues),
      JSON.stringify((existing?.actions as unknown[]) ?? []),
      input.verified ? null : input.failureSignature || 'unverified',
      JSON.stringify(evidence),
      input.attemptId,
    ],
  );
  if (next.demoted) {
    const recommendation = (input.diagnosis as { likelyCause?: { recommendation?: string } } | null)
      ?.likelyCause?.recommendation || 'Review the captured evidence and run detection again.';
    await sql(
      `insert into review_items (
         user_id, attempt_id, strategy_id, type, title, detail, next_action
       )
       select $1, $2, strategies.id, 'run-regression', $3, $4, $5
       from strategies
       where strategies.user_id = $1
         and strategies.capability_id = $6
         and strategies.capability_version = $7
         and strategies.fingerprint is not distinct from $8
         and not exists (
           select 1 from review_items
           where user_id = $1 and attempt_id = $2 and type = 'run-regression'
         )`,
      [
        input.userId,
        input.attemptId,
        `${input.capabilityId} needs review`,
        input.failureSignature || 'The helper did not provide verified completion evidence.',
        recommendation,
        input.capabilityId,
        input.capabilityVersion,
        input.fingerprint,
      ],
    );
  }
}
