// lib/executor-ledger.js
//
// Lightweight bridge for scripts that can run either through the dashboard or
// directly from the CLI. Dashboard runs reuse the server-created attempt;
// direct runs create and finish their own ledger attempt.

const {
  appendEvent,
  createAttempt,
  finishAttempt,
  recordStep,
} = require('./attempt-ledger');
const { observeOutcome } = require('./learning-engine');

function startExecutor(options) {
  const inheritedId = process.env.SABA_ATTEMPT_ID;
  const attemptId = inheritedId || createAttempt({
    source: 'direct-cli',
    capabilityId: options.capabilityId,
    capabilityVersion: options.capabilityVersion || 1,
    fingerprint: options.fingerprint || process.env.SABA_FINGERPRINT || null,
    target: options.target || null,
    risk: options.risk || 'medium',
  });
  recordStep(attemptId, 'executor-entered', {
    script: options.script,
    inherited: !!inheritedId,
  });
  return { attemptId, inherited: !!inheritedId, ...options };
}

function finishExecutor(context, result) {
  appendEvent(context.attemptId, 'executor-summary', result);
  if (context.inherited) return;
  finishAttempt(context.attemptId, result.outcome, {
    verified: !!result.verified,
    status: result.status,
    failureSignature: result.failureSignature,
    artifacts: result.artifacts || [],
    exitCode: result.exitCode ?? (result.outcome === 'success' ? 0 : 1),
  });
  observeOutcome({
    attemptId: context.attemptId,
    capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion || 1,
    fingerprint: context.fingerprint || null,
    targetId: result.targetId || context.target || context.script,
    actions: context.actions || [],
    outcome: result.outcome,
    verified: !!result.verified,
    failureSignature: result.failureSignature,
  });
}

module.exports = { finishExecutor, startExecutor };
