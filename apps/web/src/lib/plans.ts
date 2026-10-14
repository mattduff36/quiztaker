import { randomUUID } from 'node:crypto';
import { getCapability, riskLevels, validateCapabilityInput, type PlanProposal, type PlanTarget } from '@quiztaker/core';
import { capabilityNegotiationError } from '@/lib/capability-negotiation';
import { assertLearnerDetectionMatch, learnerConstraints, learnerGuidanceText } from '@/lib/learner';
import { parityAllows } from '@/lib/parity';
import { queryOne, queryRows } from '@/lib/db';

export interface CreatePlanInput {
  capabilityId: string;
  helperId: string;
  source?: PlanProposal['source'];
  args?: string[];
  label?: string;
  risk?: PlanProposal['risk'];
  steps?: string[];
  constraints?: Record<string, unknown> | null;
  targets?: PlanTarget[];
  confidence?: number;
  evidence?: string[];
  fingerprint?: string | null;
  tabIdx?: number | null;
  capabilityInput?: Record<string, unknown>;
}

export async function createPlan(userId: string, input: CreatePlanInput): Promise<PlanProposal> {
  const capability = getCapability(input.capabilityId);
  if (!capability) throw new Error('Unknown capability');
  if (!parityAllows(capability.id)) throw new Error('This action is disabled');
  await assertHelperSupports(userId, input.helperId, capability.id, capability.version);
  const capabilityInput = { ...(input.capabilityInput ?? { capabilityId: capability.id }) };
  const isLearner = capability.id === 'quiz-learn';
  if (isLearner) {
    await assertLearnerPage(userId, input.helperId, capabilityInput);
    const guidance = learnerGuidanceText(capabilityInput.guidance);
    if (!guidance.ok) throw new Error(guidance.error);
    if (guidance.guidance) capabilityInput.guidance = guidance.guidance;
    else delete capabilityInput.guidance;
  }
  const target = capabilityInput.target as { browserSessionId?: string; revision?: number } | undefined;
  const risk = higherRisk(capability.risk, input.risk);
  const attemptId = randomUUID();
  const source = input.source ?? 'manual-capability';
  let args = input.args ?? capability.args ?? [];
  if (input.capabilityInput || ['cert-batch', 'class-batch', 'open-url', 'fit-tab', 'slickquiz-solve', 'tab-inspect', 'quiz-learn'].includes(capability.id)) {
    const validated = validateCapabilityInput(capability.id, capabilityInput);
    if (!validated.ok) throw new Error(validated.error);
    args = validated.args;
  }
  const constraints = isLearner ? learnerConstraints() : input.constraints ?? null;
  const steps = isLearner ? ['probe', 'answer-select', 'verify'] : input.steps ?? [];
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const row = await queryOne<Record<string, unknown>>(
    `insert into plans (
       attempt_id, user_id, helper_id, source, capability_id, capability_version,
       script, args, label, risk, mutates_course, verifier, steps, constraints,
       targets, confidence, evidence, fingerprint, tab_idx, expires_at, input,
       browser_session_id, target_revision
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb,
       $14::jsonb, $15::jsonb, $16, $17::jsonb, $18, $19, $20, $21::jsonb, $22, $23
     )
     returning *`,
    [
      attemptId,
      userId,
      input.helperId,
      source,
      capability.id,
      capability.version,
      capability.script,
      JSON.stringify(args),
      input.label ?? capability.label,
      risk,
      capability.mutatesCourse,
      capability.verifier,
      JSON.stringify(steps),
      constraints == null ? null : JSON.stringify(constraints),
      JSON.stringify(input.targets ?? []),
      Math.min(1, Math.max(0, input.confidence ?? 0)),
      JSON.stringify(input.evidence ?? []),
      input.fingerprint ?? null,
      input.tabIdx ?? null,
      expiresAt,
      JSON.stringify(capabilityInput),
      target?.browserSessionId ?? null,
      Number.isInteger(target?.revision) ? target?.revision : null,
    ],
  );
  if (!row) throw new Error('Could not persist plan');
  await queryRows(
    `insert into attempt_events (user_id, attempt_id, event, data)
     values ($1, $2, 'attempt-created', $3::jsonb)`,
    [userId, attemptId, JSON.stringify({
      source,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      planId: row.id,
      risk,
    })],
  );
  return mapPlan(row);
}

export function mapPlan(row: Record<string, unknown>): PlanProposal {
  return {
    planId: String(row.id),
    attemptId: String(row.attempt_id),
    userId: String(row.user_id),
    helperId: String(row.helper_id),
    source: row.source as PlanProposal['source'],
    capabilityId: String(row.capability_id),
    capabilityVersion: Number(row.capability_version),
    script: String(row.script),
    args: (row.args as string[]) ?? [],
    label: String(row.label),
    risk: row.risk as PlanProposal['risk'],
    mutatesCourse: Boolean(row.mutates_course),
    verifier: String(row.verifier),
    steps: (row.steps as string[]) ?? [],
    constraints: row.constraints as Record<string, unknown> | null,
    targets: (row.targets as PlanTarget[]) ?? [],
    confidence: Number(row.confidence),
    evidence: (row.evidence as string[]) ?? [],
    fingerprint: row.fingerprint ? String(row.fingerprint) : null,
    tabIdx: row.tab_idx == null ? null : Number(row.tab_idx),
    confirmed: Boolean(row.confirmed),
    consumed: Boolean(row.consumed),
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    ...(row.confirmed_at ? { confirmedAt: new Date(String(row.confirmed_at)).toISOString() } : {}),
  };
}

export async function assertHelperSupports(
  userId: string,
  helperId: string,
  capabilityId: string,
  capabilityVersion: number,
): Promise<void> {
  const helper = await queryOne<{ protocol_version: number; supported_capabilities: Array<{ id?: string; version?: number }> }>(
    'select protocol_version, supported_capabilities from helpers where id = $1 and user_id = $2',
    [helperId, userId],
  );
  const error = capabilityNegotiationError({
    protocolVersion: helper?.protocol_version ?? 1,
    supported: Array.isArray(helper?.supported_capabilities) ? helper.supported_capabilities : [],
    capabilityId,
    capabilityVersion,
  });
  if (error) throw new Error(error);
}

async function assertLearnerPage(
  userId: string,
  helperId: string,
  capabilityInput: Record<string, unknown>,
): Promise<void> {
  const session = await queryOne<{
    id: string;
    revision: number;
    tabs: Array<{ targetId?: string; index?: number; url?: string }>;
    detection: { detected?: string | null; tabIdx?: number | null; url?: string | null } | null;
  }>(
    `select id, revision, tabs, detection
     from browser_sessions
     where user_id = $1 and helper_id = $2 and closed_at is null
     order by updated_at desc
     limit 1`,
    [userId, helperId],
  );
  if (!session) throw new Error('Learn quiz needs the selected browser tab');
  const target = capabilityInput.target as { targetId?: string; browserSessionId?: string; revision?: number } | undefined;
  assertLearnerDetectionMatch({
    sessionId: session.id,
    revision: Number(session.revision),
    tabs: session.tabs ?? [],
    detection: session.detection,
    target,
  });
}

function higherRisk(left: PlanProposal['risk'], right?: PlanProposal['risk']): PlanProposal['risk'] {
  if (!right) return left;
  return riskLevels[Math.max(riskLevels.indexOf(left), riskLevels.indexOf(right))] ?? left;
}
