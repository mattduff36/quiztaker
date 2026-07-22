import { getCapabilityForRun, isMutatingRun } from './capabilities.js';
import type { PlanProposal } from './types.js';

export interface RunAuthorization {
  ok: boolean;
  status: number;
  error?: string;
}

export function authorizeRun(input: {
  script: string;
  args: string[];
  plan: PlanProposal | null;
  now?: Date;
}): RunAuthorization {
  const capability = getCapabilityForRun(input.script, input.args);
  if (!capability) return denied(400, 'Unknown capability');

  const isMutating = isMutatingRun(input.script, input.args);
  if (!isMutating) return { ok: true, status: 200 };
  if (!input.plan) return denied(403, 'A confirmed plan is required');
  if (!input.plan.confirmed) return denied(403, 'The plan has not been confirmed');
  if (input.plan.consumed) return denied(409, 'The plan has already been consumed');
  if (Date.parse(input.plan.expiresAt) <= (input.now ?? new Date()).getTime()) {
    return denied(410, 'The plan has expired');
  }
  if (
    input.plan.script !== input.script ||
    input.plan.capabilityId !== capability.id ||
    input.plan.capabilityVersion !== capability.version ||
    !sameArgs(input.plan.args, input.args)
  ) return denied(409, 'The requested run differs from the confirmed plan');

  return { ok: true, status: 200 };
}

function sameArgs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function denied(status: number, error: string): RunAuthorization {
  return { ok: false, status, error };
}
