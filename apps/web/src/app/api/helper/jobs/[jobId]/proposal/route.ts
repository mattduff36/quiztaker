import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LEARNER_MAX_STEPS, type LearnerSnapshot } from '@/lib/learner';
import { queryOne, withTransaction } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import { askCursorLearner } from '@/lib/cursor-learner';
import { learnerGuidanceText, learnerModelChain, learnerPrefersCursor, requestLearnerDecision } from '@/lib/learner';
import {
  chooseProposalLearner,
  completeHostedChat,
  decryptLlmKey,
  llmCredentialKey,
  loadSecretLlmConnection,
} from '@/lib/llm-provider';
import { authenticateHelper } from '@/lib/security';

const control = z.object({
  id: z.string().max(8),
  name: z.string().max(160),
});

const schema = z.object({
  snapshot: z.object({
    title: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
    text: z.string().max(8000).optional(),
    choices: z.array(control).max(40).optional(),
    buttons: z.array(control).max(40).optional(),
  }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const { jobId } = await context.params;
  const job = await queryOne<{
    status: string;
    capability_id: string;
    attempt_id: string;
    constraints: { maxSteps?: number; submissionAuthorized?: boolean } | null;
    input: { guidance?: unknown } | null;
  }>(
    `select jobs.status, jobs.capability_id, plans.attempt_id, plans.constraints, plans.input
     from jobs
     join plans on plans.id = jobs.plan_id
     where jobs.id = $1 and jobs.helper_id = $2 and jobs.user_id = $3`,
    [jobId, helper.helperId, helper.userId],
  );
  if (!job || job.capability_id !== 'quiz-learn') {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (!['queued', 'dispatched', 'running'].includes(job.status)) {
    return NextResponse.json({ stop: true, error: 'The learner job is not running' });
  }
  if (!job.constraints || job.constraints.submissionAuthorized !== false) {
    return NextResponse.json({ stop: true, error: 'Submission is not authorized' });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ stop: true, error: 'Learner snapshot is invalid' });
  const storedGuidance = learnerGuidanceText(job.input?.guidance);
  if (!storedGuidance.ok) return NextResponse.json({ stop: true, error: storedGuidance.error });
  const incoming = parsed.data.snapshot;
  const snapshot: LearnerSnapshot = {
    title: incoming.title,
    url: incoming.url,
    text: incoming.text,
    choices: incoming.choices,
    buttons: incoming.buttons,
    ...(storedGuidance.guidance ? { guidance: storedGuidance.guidance } : {}),
  };
  const stored = await loadSecretLlmConnection(helper.userId);
  const choice = chooseProposalLearner(stored);
  if (choice.kind === 'disabled') {
    return NextResponse.json({ stop: true, error: 'Hosted learner is disconnected' });
  }
  if (choice.kind === 'blocked') {
    return NextResponse.json({ stop: true, error: 'Hosted learner connection is not ready' });
  }
  const maxSteps = Math.min(LEARNER_MAX_STEPS, Number(job.constraints.maxSteps ?? LEARNER_MAX_STEPS));
  const reserved = await withTransaction(async (sql) => {
    await sql(
      `select id from jobs
       where id = $1 and helper_id = $2 and user_id = $3
       for update`,
      [jobId, helper.helperId, helper.userId],
    );
    const rows = await sql<{ count: string }>(
      `select count(*)::text as count
       from attempt_events
       where user_id = $1 and attempt_id = $2 and event = 'learner-step'`,
      [helper.userId, job.attempt_id],
    );
    if (Number(rows[0]?.count ?? 0) >= maxSteps) return false;
    await sql(
      `insert into attempt_events (user_id, attempt_id, event, data)
       values ($1, $2, 'learner-step', $3::jsonb)`,
      [helper.userId, job.attempt_id, JSON.stringify({ jobId, action: 'reserved' })],
    );
    return true;
  });
  if (!reserved) return NextResponse.json({ stop: true, error: 'Learner step cap reached' });
  if (choice.kind === 'personal') {
    let apiKey: string;
    try {
      apiKey = decryptLlmKey(helper.userId, choice, llmCredentialKey(process.env.LLM_CREDENTIAL_KEY), choice.provider);
    } catch {
      return NextResponse.json({ stop: true, error: 'Hosted learner connection is not ready' });
    }
    const personal = await completeHostedChat({
      provider: choice.provider,
      model: choice.model,
      apiKey,
      snapshot,
    });
    if (!personal.ok) return NextResponse.json({ stop: true, error: personal.error });
    return NextResponse.json({ action: personal.action });
  }
  const env = getServerEnv();
  const cursorKey = env.CURSOR_API_KEY;
  const preferCursor = learnerPrefersCursor({
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
    cursorApiKey: cursorKey,
  });
  const decision = await requestLearnerDecision({
    apiKey: env.LEARNER_API_KEY,
    baseUrl: env.LEARNER_BASE_URL,
    model: env.LEARNER_MODEL,
    models: learnerModelChain({
      model: env.LEARNER_MODEL,
      models: env.LEARNER_MODELS,
      baseUrl: env.LEARNER_BASE_URL,
    }),
    snapshot,
    cursor: preferCursor && cursorKey
      ? (snapshot) => askCursorLearner({ apiKey: cursorKey, model: env.CURSOR_MODEL, snapshot })
      : undefined,
  });
  if (!decision.action || decision.stop) {
    return NextResponse.json({ stop: true, error: decision.error || 'Learner stopped' });
  }
  return NextResponse.json({ action: decision.action });
}
