const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-learning-test-'));
process.env.SABA_KNOWLEDGE_DIR = path.join(tempRoot, 'knowledge');
process.env.SABA_QUIZ_TYPES_FILE = path.join(tempRoot, 'QUIZ-TYPES.md');
fs.writeFileSync(process.env.SABA_QUIZ_TYPES_FILE, '# Fixture\n');

const {
  findPromotedStrategy,
  getLearningSummary,
  observeOutcome,
  rankCandidate,
  readStrategies,
  validateActions,
} = require('./lib/learning-engine');

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('promotes only after three independent verified successes on two targets', () => {
  const base = {
    capabilityId: 'fixture-strategy',
    capabilityVersion: 1,
    fingerprint: 'fixture-fingerprint',
    actions: ['probe', 'click', 'verify'],
    outcome: 'success',
    verified: true,
  };
  assert.equal(observeOutcome({ ...base, attemptId: 'a1', targetId: 'course-a' }).status, 'candidate');
  assert.equal(observeOutcome({ ...base, attemptId: 'a2', targetId: 'course-b' }).status, 'candidate');
  assert.equal(observeOutcome({ ...base, attemptId: 'a3', targetId: 'course-a' }).status, 'promoted');

  const strategy = Object.values(readStrategies().strategies)[0];
  assert.equal(strategy.successes, 3);
  assert.deepEqual(strategy.targets.sort(), ['course-a', 'course-b']);
});

test('demotes a promoted strategy after regression', () => {
  const strategy = observeOutcome({
    capabilityId: 'fixture-strategy',
    capabilityVersion: 1,
    fingerprint: 'fixture-fingerprint',
    attemptId: 'a4',
    targetId: 'course-b',
    actions: ['probe', 'click', 'verify'],
    outcome: 'failure',
    verified: false,
    failureSignature: 'fixture-regression',
  });
  assert.equal(strategy.status, 'needs-review');
  assert.equal(getLearningSummary().counts.openReviews, 1);
  const laterSuccess = observeOutcome({
    capabilityId: 'fixture-strategy',
    capabilityVersion: 1,
    fingerprint: 'fixture-fingerprint',
    attemptId: 'a5',
    targetId: 'course-c',
    actions: ['probe', 'click', 'verify'],
    outcome: 'success',
    verified: true,
  });
  assert.equal(laterSuccess.status, 'needs-review');
});

test('safe action DSL rejects arbitrary actions', () => {
  assert.equal(validateActions(['probe', 'click', 'verify']), true);
  assert.equal(validateActions(['probe', 'evaluate-javascript']), false);
});

test('ranker exposes promoted exact-fingerprint evidence', () => {
  const base = {
    capabilityId: 'ranked-strategy',
    capabilityVersion: 1,
    fingerprint: 'ranked-fingerprint',
    actions: ['probe', 'click', 'verify'],
    outcome: 'success',
    verified: true,
  };
  observeOutcome({ ...base, attemptId: 'r1', targetId: 'one' });
  observeOutcome({ ...base, attemptId: 'r2', targetId: 'two' });
  observeOutcome({ ...base, attemptId: 'r3', targetId: 'one' });
  assert.equal(findPromotedStrategy('ranked-fingerprint').capabilityId, 'ranked-strategy');
  const ranked = rankCandidate('ranked-strategy', 'ranked-fingerprint', 0.8);
  assert.ok(ranked.confidence > 0.8);
  assert.match(ranked.evidence, /Exact measured evidence/);
});
