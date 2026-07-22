// lib/plan-policy.js
//
// Pure authorization policy for matching a run to its confirmed plan.

const { getCapabilityForRun, isMutatingRun } = require('./capabilities');

function authorizeRun({ script, args = [], plan = null }) {
  const safeArgs = args.map(String);
  const capability = getCapabilityForRun(script, safeArgs);
  if (!capability) return { ok: false, status: 400, error: 'no capability registered for this run' };
  if (!isMutatingRun(script, safeArgs)) return { ok: true, capability };
  if (!plan || !plan.confirmed || plan.consumed) {
    return { ok: false, status: 403, error: 'a confirmed, unconsumed plan is required' };
  }
  if (plan.script !== script || JSON.stringify(plan.args) !== JSON.stringify(safeArgs)) {
    return { ok: false, status: 400, error: 'run does not match the confirmed plan' };
  }
  return { ok: true, capability };
}

module.exports = { authorizeRun };
