import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LEARNER_MAX_STEPS, type LearnerAction, type LearnerSnapshot } from '@/lib/learner';
import { queryOne, withTransaction } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import { askCursorLearner } from '@/lib/cursor-learner';
import { boundLearnerSnapshot, learnerGuidanceText, learnerModelChain, learnerPrefersCursor, requestLearnerDecision } from '@/lib/learner';
import {
  composeLearnerSnapshot,
  parseLearnerConversationId,
  readLearnerSessionForModel,
  recordLearnerTurn,
} from '@/lib/learner-memory';
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
    input: { guidance?: unknown; conversationId?: unknown } | null;
    browser_session_id: string | null;
  }>(
    `select jobs.status, jobs.capability_id, plans.attempt_id, plans.constraints, plans.input,
            plans.browser_session_id
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
  const conversation = storedConversation(job.input?.conversationId, job.browser_session_id);
  if (!conversation.ok) return NextResponse.json({ stop: true, error: conversation.error });
  let retained: Awaited<ReturnType<typeof readLearnerSessionForModel>> = null;
  if (conversation.id) {
    try {
      retained = await readLearnerSessionForModel({
        userId: helper.userId,
        helperId: helper.helperId,
        browserSessionId: conversation.browserSessionId,
        conversationId: conversation.id,
      });
    } catch {
      return NextResponse.json({ stop: true, error: 'Learner memory could not be read' });
    }
    if (!retained) return NextResponse.json({ stop: true, error: 'Learner conversation was not found' });
  }
  const modelSnapshot = boundLearnerSnapshot(composeLearnerSnapshot(snapshot, retained));
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
      snapshot: modelSnapshot,
    });
    return finishLearnerDecision(conversation, helper.userId, helper.helperId, incoming, personal.ok
      ? { action: personal.action }
      : { stop: true, error: personal.error });
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
    snapshot: modelSnapshot,
    cursor: preferCursor && cursorKey
      ? (current) => askCursorLearner({ apiKey: cursorKey, model: env.CURSOR_MODEL, snapshot: current })
      : undefined,
  });
  return finishLearnerDecision(
    conversation,
    helper.userId,
    helper.helperId,
    incoming,
    decision.action && !decision.stop
      ? { action: decision.action }
      : { stop: true, error: decision.error || 'Learner stopped' },
  );
}

function storedConversation(
  value: unknown,
  browserSessionId: string | null,
): { ok: true; id: string | null; browserSessionId: string } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, id: null, browserSessionId: browserSessionId ?? '' };
  try {
    const id = parseLearnerConversationId(value);
    if (!id || !browserSessionId) return { ok: false, error: 'Learner conversation was not found' };
    return { ok: true, id, browserSessionId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Learner conversation id is invalid' };
  }
}

async function finishLearnerDecision(
  conversation: { id: string | null; browserSessionId: string },
  userId: string,
  helperId: string,
  observed: { title?: string; url?: string; text?: string },
  decision: { action?: LearnerAction; stop?: boolean; error?: string },
) {
  if (conversation.id) {
    try {
      const saved = await recordLearnerTurn({
        userId,
        helperId,
        browserSessionId: conversation.browserSessionId,
        conversationId: conversation.id,
        observed,
        decision,
      });
      if (!saved) return NextResponse.json({ stop: true, error: 'Learner memory could not be saved' });
    } catch {
      return NextResponse.json({ stop: true, error: 'Learner memory could not be saved' });
    }
  }
  if (decision.action && !decision.stop) return NextResponse.json({ action: decision.action });
  return NextResponse.json({ stop: true, error: decision.error || 'Learner stopped' });
}
