import { storedLearnerPolicy } from '@quiztaker/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, withTransaction } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import {
  LEARNER_MAX_STEPS,
  learnerGuidanceText,
  learnerModelChain,
  requestLearnerDecision,
  withStandingInstructions,
  type LearnerAction,
  type LearnerSnapshot,
} from '@/lib/learner';
import {
  composeLearnerSnapshot,
  parseLearnerConversationId,
  readLearnerSessionForModel,
  recordLearnerTurn,
} from '@/lib/learner-memory';
import { readLearnerInstructions } from '@/lib/learner-preferences';
import {
  chooseProposalLearner,
  completeHostedChat,
  decryptLlmKey,
  llmCredentialKey,
  loadSecretLlmConnection,
} from '@/lib/llm-provider';
import { authenticateHelper } from '@/lib/security';
import { enforceOperatorIdle, readOperatorActivity } from '@/lib/operator-activity';
import { observePlayerKnowledge, withPlayerKnowledge } from '@/lib/player-knowledge';
import { recordCourseCoverage } from '@/lib/course-coverage';

export const maxDuration = 120;

const control = z.object({
  id: z.string().max(8),
  name: z.string().max(160),
  kind: z.enum(['content', 'navigation', 'quiz-navigation', 'submission']).optional(),
  checked: z.boolean().optional(),
});

const schema = z.object({
  snapshot: z.object({
    title: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
    text: z.string().max(8000).optional(),
    choices: z.array(control).max(40).optional(),
    buttons: z.array(control).max(40).optional(),
    tabs: z.array(z.object({id:z.string().max(8),name:z.string().max(160),url:z.string().max(500)})).max(20).optional(),
    image: z.string().max(900_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/).optional(),
    outlines: z.array(z.object({url:z.string().max(500),title:z.string().max(200),topics:z.array(z.string().max(160)).max(60)})).max(4).optional(),
  }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  await enforceOperatorIdle(helper.userId,helper.helperId);
  if ((await readOperatorActivity(helper.userId,helper.helperId))?.paused) return NextResponse.json({stop:true,error:'Session paused after inactivity. Resume it in Operations.'});
  const { jobId } = await context.params;
  const job = await queryOne<{
    status: string;
    cancel_requested: boolean;
    capability_id: string;
    attempt_id: string;
    constraints: { mode?: unknown; maxSteps?: number; submissionAuthorized?: boolean } | null;
    input: { mode?: unknown; guidance?: unknown; conversationId?: unknown } | null;
    browser_session_id: string | null;
  }>(
    `select jobs.status, jobs.cancel_requested, jobs.capability_id, plans.attempt_id, plans.constraints, plans.input,
            plans.browser_session_id
     from jobs
     join plans on plans.id = jobs.plan_id
     where jobs.id = $1 and jobs.helper_id = $2 and jobs.user_id = $3`,
    [jobId, helper.helperId, helper.userId],
  );
  if (!job || job.capability_id !== 'quiz-learn') {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.cancel_requested || !['queued', 'dispatched', 'running'].includes(job.status)) {
    return NextResponse.json({ stop: true, error: 'The learner job is not running' });
  }
  let policy;
  try { policy = storedLearnerPolicy(job.input, job.constraints); }
  catch { return NextResponse.json({ stop: true, error: 'Learner mode is not authorized by this plan' }); }
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
    tabs: incoming.tabs,
    image: incoming.image,
    outlines: incoming.outlines,
    ...(storedGuidance.guidance ? { guidance: storedGuidance.guidance } : {}),
  };
  await recordCourseCoverage({userId:helper.userId,attemptId:job.attempt_id,snapshot}).catch(() => { console.warn('Course coverage could not be updated'); });
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
  let instructions: string;
  try {
    instructions = (await readLearnerInstructions(helper.userId)).instructions;
  } catch {
    return NextResponse.json({ stop: true, error: 'Learner instructions could not be read' });
  }
  // Player documentation is bounded navigation context, never action authority.
  // Knowledge-store or public-document failures must not stop the course run.
  const playerKnowledge = await observePlayerKnowledge({ userId: helper.userId, attemptId: job.attempt_id, snapshot })
    .catch(() => { console.warn('Player knowledge could not be updated'); return null; });
  const composed = composeLearnerSnapshot(snapshot, retained);
  const modelSnapshot = withStandingInstructions(playerKnowledge ? withPlayerKnowledge(composed, playerKnowledge) : composed, instructions);
  const stored = await loadSecretLlmConnection(helper.userId);
  const choice = chooseProposalLearner(stored);
  if (choice.kind === 'disabled') {
    return NextResponse.json({ stop: true, error: 'Hosted learner is disconnected' });
  }
  if (choice.kind === 'blocked') {
    return NextResponse.json({ stop: true, error: 'Hosted learner connection is not ready' });
  }
  const maxSteps = Math.min(LEARNER_MAX_STEPS, Number(job.constraints?.maxSteps ?? LEARNER_MAX_STEPS));
  const reserved = await withTransaction(async (sql) => {
    const [current] = await sql<{status:string;cancel_requested:boolean}>(
      `select status,cancel_requested from jobs
       where id = $1 and helper_id = $2 and user_id = $3
       for no key update`,
      [jobId, helper.helperId, helper.userId],
    );
    if(!current || current.cancel_requested || !['queued','dispatched','running'].includes(current.status))return false;
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
      policy,
      userId: helper.userId,
    });
    if (personal.evidence?.length) {
      await queryOne(`insert into attempt_events (user_id, attempt_id, event, data) values ($1,$2,'learner-tools',$3::jsonb) returning id`,
        [helper.userId,job.attempt_id,JSON.stringify({jobId,evidence:personal.evidence})]);
    }
    return finishLearnerDecision(jobId, conversation, helper.userId, helper.helperId, incoming, personal.ok
      ? { action: personal.action }
      : { stop: true, error: personal.error });
  }
  const env = getServerEnv();
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
    policy,
  });
  return finishLearnerDecision(
    jobId,
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
  jobId: string,
  conversation: { id: string | null; browserSessionId: string },
  userId: string,
  helperId: string,
  observed: { title?: string; url?: string; text?: string },
  decision: { action?: LearnerAction; stop?: boolean; error?: string },
) {
  return withTransaction(async sql => {
  const [current]=await sql<{status:string;cancel_requested:boolean}>(`select status,cancel_requested from jobs where id=$1 and user_id=$2 and helper_id=$3 for no key update`,[jobId,userId,helperId]);
  if(!current || current.cancel_requested || !['queued','dispatched','running'].includes(current.status)) return NextResponse.json({stop:true,error:'This task has stopped. No further browser action is allowed.'});
  if (conversation.id) {
    try {
      const saved = await recordLearnerTurn({
        userId,
        helperId,
        browserSessionId: conversation.browserSessionId,
        conversationId: conversation.id,
        observed,
        decision,
      }, {query:sql,transaction:fn=>fn(sql)});
      if (!saved) return NextResponse.json({ stop: true, error: 'Learner memory could not be saved' });
    } catch {
      return NextResponse.json({ stop: true, error: 'Learner memory could not be saved' });
    }
  }
  if (decision.action && !decision.stop) return NextResponse.json({ action: decision.action });
  return NextResponse.json({ stop: true, error: decision.error || 'Learner stopped' });
  });
}
