export interface StrategyEvidence {
  successAttemptIds: string[];
  failureAttemptIds: string[];
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface StrategySnapshot {
  successes: number;
  failures: number;
  status: string;
  targets: string[];
  evidence: StrategyEvidence;
}

export function nextStrategyState(
  existing: StrategySnapshot | null,
  input: { attemptId: string; verified: boolean; targets: string[]; at: string },
): StrategySnapshot & { demoted: boolean } {
  const evidence: StrategyEvidence = {
    successAttemptIds: [...(existing?.evidence.successAttemptIds ?? [])],
    failureAttemptIds: [...(existing?.evidence.failureAttemptIds ?? [])],
    lastSuccessAt: existing?.evidence.lastSuccessAt,
    lastFailureAt: existing?.evidence.lastFailureAt,
  };
  const targets = input.verified
    ? [...new Set([...(existing?.targets ?? []), ...input.targets].filter(Boolean))]
    : [...(existing?.targets ?? [])];
  let successes = existing?.successes ?? 0;
  let failures = existing?.failures ?? 0;
  let status = existing?.status ?? 'candidate';
  let demoted = false;
  if (input.verified) {
    if (!evidence.successAttemptIds.includes(input.attemptId)) {
      successes += 1;
      evidence.successAttemptIds.push(input.attemptId);
    }
    const unresolvedFailure = Boolean(evidence.lastFailureAt && (!evidence.lastSuccessAt || evidence.lastFailureAt > evidence.lastSuccessAt));
    evidence.lastSuccessAt = input.at;
    if (status === 'candidate' && !unresolvedFailure && successes >= 3 && targets.length >= 2) status = 'promoted';
  } else if (!evidence.failureAttemptIds.includes(input.attemptId)) {
    failures += 1;
    evidence.failureAttemptIds.push(input.attemptId);
    evidence.lastFailureAt = input.at;
    if (status === 'promoted') {
      status = 'needs-review';
      demoted = true;
    }
  }
  return { successes, failures, status, targets, evidence, demoted };
}
