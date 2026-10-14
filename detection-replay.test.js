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

test('Cornerstone curricula and assessments never reuse Saba completion actions', () => {
  assert.deepEqual(classifyProbeSignals({ urlKind: 'csod-curriculum', scorm: '1.2' }), { detected: 'csod-curriculum', capabilityId: 'learn-capture' });
  assert.deepEqual(classifyProbeSignals({ urlKind: 'csod-learning', hasAssessmentShell: true, scorm: '1.2' }), { detected: 'server-assessment', capabilityId: 'learn-capture' });
});

test('Cornerstone material is offered to the learner even with a SCORM wrapper', () => {
  assert.deepEqual(classifyProbeSignals({ urlKind: 'csod-learning', scorm: '1.2' }), { detected: 'csod-learning', capabilityId: 'learn-capture' });
});
