import { randomUUID } from 'node:crypto';
import { getCapability, riskLevels, type PlanProposal, type PlanTarget } from '@quiztaker/core';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

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
  const now = new Date();
  const row = {
    attempt_id: randomUUID(),
    user_id: userId,
    helper_id: input.helperId,
    source: input.source ?? 'manual-capability',
    capability_id: capability.id,
    capability_version: capability.version,
    script: capability.script,
    args: input.args ?? capability.args ?? [],
    label: input.label ?? capability.label,
    risk,
    mutates_course: capability.mutatesCourse,
    verifier: capability.verifier,
    steps: input.steps ?? [],
    constraints: input.constraints ?? null,
    targets: input.targets ?? [],
    confidence: Math.min(1, Math.max(0, input.confidence ?? 0)),
    evidence: input.evidence ?? [],
    fingerprint: input.fingerprint ?? null,
    tab_idx: input.tabIdx ?? null,
    expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('plans').insert(row).select('*').single();
  if (error) throw error;
  await supabase.from('attempt_events').insert({
    user_id: userId,
    attempt_id: row.attempt_id,
    event: 'attempt-created',
    data: {
      source: row.source,
      capabilityId: row.capability_id,
      capabilityVersion: row.capability_version,
      planId: data.id,
      risk,
    },
  });
  return mapPlan(data);
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
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(row.confirmed_at ? { confirmedAt: String(row.confirmed_at) } : {}),
  };
}

function higherRisk(left: PlanProposal['risk'], right?: PlanProposal['risk']): PlanProposal['risk'] {
  if (!right) return left;
  return riskLevels[Math.max(riskLevels.indexOf(left), riskLevels.indexOf(right))] ?? left;
}
