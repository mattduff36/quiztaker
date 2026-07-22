const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./detection-fixtures.json');
const { classifyProbeSignals } = require('./lib/detection-engine');
const { createAction } = require('./lib/capabilities');

test('replays sanitized probe classifications for every documented variant', async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const classification = classifyProbeSignals(fixture.probe);
      assert.deepEqual(classification, fixture.expected);
      if (classification.capabilityId) {
        const action = createAction(classification.capabilityId);
        assert.equal(action.capabilityId, classification.capabilityId);
        assert.ok(action.verifier);
      }
    });
  }
});
