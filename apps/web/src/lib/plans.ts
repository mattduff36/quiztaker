import { randomUUID } from 'node:crypto';
import { getCapability, riskLevels, type PlanProposal, type PlanTarget } from '@quiztaker/core';
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
}

export async function createPlan(userId: string, input: CreatePlanInput): Promise<PlanProposal> {
  const capability = getCapability(input.capabilityId);
  if (!capability) throw new Error('Unknown capability');
  const risk = higherRisk(capability.risk, input.risk);
  const attemptId = randomUUID();
  const source = input.source ?? 'manual-capability';
  const args = input.args ?? capability.args ?? [];
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const row = await queryOne<Record<string, unknown>>(
    `insert into plans (
       attempt_id, user_id, helper_id, source, capability_id, capability_version,
       script, args, label, risk, mutates_course, verifier, steps, constraints,
       targets, confidence, evidence, fingerprint, tab_idx, expires_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb,
       $14::jsonb, $15::jsonb, $16, $17::jsonb, $18, $19, $20
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
      JSON.stringify(input.steps ?? []),
      input.constraints == null ? null : JSON.stringify(input.constraints),
      JSON.stringify(input.targets ?? []),
      Math.min(1, Math.max(0, input.confidence ?? 0)),
      JSON.stringify(input.evidence ?? []),
      input.fingerprint ?? null,
      input.tabIdx ?? null,
      expiresAt,
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

function higherRisk(left: PlanProposal['risk'], right?: PlanProposal['risk']): PlanProposal['risk'] {
  if (!right) return left;
  return riskLevels[Math.max(riskLevels.indexOf(left), riskLevels.indexOf(right))] ?? left;
}
