import { createHash, randomUUID } from 'node:crypto';
import {
  authorizeRun,
  classifyOutcome,
  deriveHelperSecret,
  diagnoseRun,
  signJob,
  type JobEnvelope,
  type JobEventInput,
} from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { mapPlan } from '@/lib/plans';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function createJob(userId: string, planId: string): Promise<{ jobId: string }> {
  const supabase = createSupabaseAdminClient();
  const { data: rawPlan, error } = await supabase
    .from('plans')
    .select('*')
    .eq('id', planId)
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  let plan = mapPlan(rawPlan);
  if (!plan.mutatesCourse && !plan.confirmed) {
    const confirmedAt = new Date().toISOString();
    const { data, error: confirmError } = await supabase
      .from('plans')
      .update({ confirmed: true, confirmed_at: confirmedAt })
      .eq('id', planId)
      .eq('consumed', false)
      .select('*')
      .single();
    if (confirmError) throw confirmError;
    plan = mapPlan(data);
  }

  const authorization = authorizeRun({ script: plan.script, args: plan.args, plan });
  if (!authorization.ok) throw new Error(authorization.error || 'Run is not authorized');
  const jobId = randomUUID();
  const { error: jobError } = await supabase.rpc('consume_plan_and_create_job', {
    p_plan_id: planId,
    p_user_id: userId,
    p_job_id: jobId,
  });
  if (jobError) throw jobError;
  await supabase.from('attempt_events').insert({
    user_id: userId,
    attempt_id: plan.attemptId,
    event: 'step',
    data: { step: 'job-queued', jobId },
  });
  return { jobId };
}

export async function claimNextJob(helperId: string, userId: string): Promise<JobEnvelope | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('claim_next_helper_job', {
    p_helper_id: helperId,
    p_user_id: userId,
  });
  if (error) throw error;
  const claimed = Array.isArray(data) ? data[0] : data;
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
    args: claimed.args as string[],
    fingerprint: claimed.fingerprint ? String(claimed.fingerprint) : null,
    nonce: String(claimed.nonce),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };
  const secret = deriveHelperSecret(getServerEnv().HELPER_MASTER_KEY, helperId);
  return signJob(payload, secret);
}

export async function recordJobEvent(
  helperId: string,
  userId: string,
  jobId: string,
  input: JobEventInput,
): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: job, error: jobLookupError } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('helper_id', helperId)
    .eq('user_id', userId)
    .single();
  if (jobLookupError) throw jobLookupError;

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
  if (!isOutputEvent || input.sequence <= 202) {
    const { error: eventError } = await supabase.from('job_events').insert({
      user_id: userId,
      job_id: jobId,
      sequence: input.sequence,
      event: input.event,
      data: eventData,
      occurred_at: input.occurredAt,
    });
    if (eventError?.code === '23505') return;
    if (eventError) throw eventError;
  }

  if (input.event === 'started') {
    await supabase.from('jobs').update({
      status: 'running',
      started_at: input.occurredAt,
    }).eq('id', jobId);
    return;
  }
  if (!['completed', 'failed', 'cancelled'].includes(input.event)) return;

  if (!output) {
    const { data: chunks } = await supabase
      .from('job_events')
      .select('event,data')
      .eq('job_id', jobId)
      .in('event', ['stdout', 'stderr'])
      .order('sequence');
    output = (chunks ?? []).map((row) => String((row.data as { text?: string })?.text ?? '')).join('');
  }
  const outputPath = `${userId}/${jobId}/output.txt`;
  await supabase.storage.from('private-artifacts').upload(outputPath, output, {
    contentType: 'text/plain; charset=utf-8',
    upsert: true,
  });
  await supabase.from('artifacts').upsert({
    user_id: userId,
    helper_id: helperId,
    job_id: jobId,
    storage_path: outputPath,
    media_type: 'text/plain; charset=utf-8',
    size_bytes: Buffer.byteLength(output),
    sha256: createHash('sha256').update(output).digest('hex'),
  }, { onConflict: 'storage_path' });
  const code = input.event === 'cancelled' ? null : Number(input.data.code ?? 1);
  const outcome = input.event === 'cancelled'
    ? { outcome: 'cancelled' as const, verified: false, status: 'cancelled' }
    : classifyOutcome({ script: String(job.script), code, output });
  const diagnosis = diagnoseRun({ script: String(job.script), code, output, outcome });
  await supabase.from('jobs').update({
    status: input.event === 'completed' && outcome.outcome === 'success' && outcome.verified
      ? 'completed'
      : input.event === 'cancelled' ? 'cancelled' : 'failed',
    exit_code: code,
    outcome,
    diagnosis,
    output_path: outputPath,
    finished_at: input.occurredAt,
  }).eq('id', jobId);
  await supabase.from('helpers').update({
    status: 'online',
    active_job_id: null,
  }).eq('id', helperId);
  await supabase.from('attempt_events').insert({
    user_id: userId,
    attempt_id: job.attempt_id,
    event: 'attempt-finished',
    data: { ...outcome, diagnosis, jobId },
    occurred_at: input.occurredAt,
  });
  const { data: plan } = await supabase.from('plans').select('label,targets')
    .eq('id', job.plan_id)
    .maybeSingle();
  await supabase.from('history_events').upsert({
    user_id: userId,
    helper_id: helperId,
    source_id: `job:${jobId}`,
    kind: 'automation',
    title: plan?.label || String(job.script),
    result: outcome.status,
    detail: outcome.verified ? 'Verified by the configured completion signal.' : 'Completion was not verified.',
    occurred_at: input.occurredAt,
    payload: { jobId, outcome, diagnosis },
  }, { onConflict: 'user_id,helper_id,source_id' });
  await updateStrategyEvidence(supabase, {
    userId,
    attemptId: String(job.attempt_id),
    capabilityId: String(job.capability_id),
    capabilityVersion: Number(job.capability_version),
    fingerprint: job.fingerprint ? String(job.fingerprint) : null,
    targets: (plan?.targets as Array<{ id?: string; title: string }> | null) ?? [],
    verified: outcome.verified,
    failureSignature: outcome.failureSignature,
    diagnosis,
  });
}

async function updateStrategyEvidence(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    userId: string;
    attemptId: string;
    capabilityId: string;
    capabilityVersion: number;
    fingerprint: string | null;
    targets: Array<{ id?: string; title: string }>;
    verified: boolean;
    failureSignature?: string;
    diagnosis: unknown;
  },
): Promise<void> {
  let query = supabase.from('strategies').select('*')
    .eq('user_id', input.userId)
    .eq('capability_id', input.capabilityId)
    .eq('capability_version', input.capabilityVersion);
  query = input.fingerprint ? query.eq('fingerprint', input.fingerprint) : query.is('fingerprint', null);
  const { data: existing } = await query.maybeSingle();
  const targetValues = [...new Set([
    ...((existing?.targets as string[] | null) ?? []),
    ...input.targets.map((target) => target.id || target.title),
  ])];
  const successes = Number(existing?.successes || 0) + (input.verified ? 1 : 0);
  const failures = Number(existing?.failures || 0) + (input.verified ? 0 : 1);
  const status = input.verified && successes >= 3 && targetValues.length >= 2
    ? 'promoted'
    : input.verified ? 'candidate' : 'needs-review';
  const values = {
    user_id: input.userId,
    capability_id: input.capabilityId,
    capability_version: input.capabilityVersion,
    fingerprint: input.fingerprint,
    status,
    successes,
    failures,
    targets: targetValues,
    actions: existing?.actions || [],
    last_failure_signature: input.verified ? null : input.failureSignature || 'unverified',
    updated_at: new Date().toISOString(),
  };
  if (existing) await supabase.from('strategies').update(values).eq('id', existing.id);
  else await supabase.from('strategies').insert(values);
  if (!input.verified) {
    await supabase.from('review_items').insert({
      user_id: input.userId,
      attempt_id: input.attemptId,
      strategy_id: existing?.id || null,
      type: 'run-regression',
      title: `${input.capabilityId} needs review`,
      detail: input.failureSignature || 'The helper did not provide verified completion evidence.',
      next_action: (input.diagnosis as { likelyCause?: { recommendation?: string } } | null)?.likelyCause?.recommendation
        || 'Review the captured evidence and run detection again.',
    });
  }
}
