const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITIES,
  SAFE_ACTIONS,
  createAction,
  listPublicCapabilities,
} = require('./lib/capabilities');

test('every mutating capability declares risk and verifier', () => {
  for (const capability of CAPABILITIES.filter((item) => item.mutatesCourse)) {
    assert.notEqual(capability.risk, 'none', capability.id);
    assert.ok(capability.verifier, capability.id);
  }
});

test('public cards and detector actions come from registry', () => {
  const publicCapabilities = listPublicCapabilities();
  assert.equal(publicCapabilities.length, CAPABILITIES.length);
  assert.ok(publicCapabilities.some((capability) => capability.id === 'cert-batch' && capability.card));
  assert.ok(publicCapabilities.some((capability) => capability.id === 'class-batch' && capability.picker === 'class-activities'));
});

test('planned action steps are restricted to safe DSL', () => {
  const action = createAction('container-batch', {
    steps: ['probe', 'launch', 'scorm-complete', 'verify', 'exit'],
  });
  assert.ok(action.steps.every((step) => SAFE_ACTIONS.has(step)));
});
