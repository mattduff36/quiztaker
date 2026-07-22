const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseRun, parseAutomationResult } = require('./lib/run-diagnosis');

function outputFor(result) {
  return [
    `${result.completed}/${result.total} confirmed Successful`,
    'Needs manual review:',
    ...result.failures.map((failure) => `  - ${failure.title}: ${failure.reason}`),
    `AUTOMATION_RESULT ${JSON.stringify(result)}`,
  ].join('\n');
}

test('diagnoses prerequisite locks from structured batch evidence', () => {
  const result = {
    schemaVersion: 1,
    kind: 'cert-batch',
    completed: 0,
    total: 2,
    failures: [
      {
        title: 'Course one',
        reason: 'prerequisites-incomplete',
        evidence: [
          'Prerequisite 1: 0/2 complete',
          'This certification requires you to follow a predefined learning sequence.',
        ],
        artifact: 'data/course-history/no-player.png',
      },
      {
        title: 'Course two',
        reason: 'prerequisites-incomplete',
        evidence: ['Prerequisite 2: 0/2 complete'],
      },
    ],
  };
  const output = outputFor(result);
  assert.deepEqual(parseAutomationResult(output), result);
  const diagnosis = diagnoseRun({
    script: 'pw-cert-batch.js',
    code: 0,
    output,
    outcome: { outcome: 'failure', failureSignature: 'manual-review' },
  });
  assert.equal(diagnosis.likelyCause.code, 'prerequisites-incomplete');
  assert.equal(diagnosis.likelyCause.confidence, 0.99);
  assert.equal(diagnosis.affectedTargets.length, 2);
  assert.deepEqual(diagnosis.artifacts, ['data/course-history/no-player.png']);
  assert.match(diagnosis.recommendations[0], /prerequisite/i);
});

test('returns no diagnosis for a fully verified batch', () => {
  const output = outputFor({
    schemaVersion: 1,
    kind: 'cert-batch',
    completed: 2,
    total: 2,
    failures: [],
  });
  assert.equal(diagnoseRun({
    script: 'pw-cert-batch.js',
    code: 0,
    output,
    outcome: { outcome: 'success' },
  }), null);
});
