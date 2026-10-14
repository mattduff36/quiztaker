import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeRun,
  classifyOutcome,
  confirmShortcutAllowed,
  decideLearnerStep,
  learnerOfferedFor,
  parseLearnerAction,
} from '../dist/index.js';

const snapshot = {
  buttons: [
    { id: 'b1', name: 'Next' },
    { id: 'b2', name: 'Submit' },
  ],
  choices: [
    { id: 'c1', name: 'Late point differentiation configuration (LPDC)' },
  ],
};

test('learner-accepts-answer-select', () => {
  const result = parseLearnerAction({ action: 'answer-select', targetId: 'c1' }, snapshot);
  assert.deepEqual(result, { ok: true, action: { action: 'answer-select', targetId: 'c1' } });
});

test('learner-rejects-exit', () => {
  const result = parseLearnerAction({ action: 'exit' }, snapshot);
  assert.equal(result.ok, false);
});

test('learner click is limited to navigation labels and verify ignores the model', () => {
  const page = {
    buttons: [
      { id: 'b1', name: 'Continue' },
      { id: 'b3', name: 'Save progress' },
    ],
    choices: snapshot.choices,
  };
  assert.deepEqual(parseLearnerAction({ action: 'click', targetId: 'b1' }, page), {
    ok: true,
    action: { action: 'click', targetId: 'b1' },
  });
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b3' }, page).ok, false);
  assert.deepEqual(parseLearnerAction({ action: 'verify', passed: true }, snapshot), {
    ok: true,
    action: { action: 'verify' },
  });
});

test('learner allows an exact course interaction and rejects other targets', () => {
  const page = {
    buttons: [
      { id: 'b1', name: 'Course interaction: 1_110_click1' },
      { id: 'b4', name: 'Course interaction: 1_110_slide' },
      { id: 'b5', name: 'Course interaction: scan-and-store.jpg' },
      { id: 'b6', name: 'Open topic: Scan and Store (notstarted)' },
    ],
    choices: snapshot.choices,
  };
  assert.deepEqual(parseLearnerAction({ action: 'click', targetId: 'b1' }, page), {
    ok: true,
    action: { action: 'click', targetId: 'b1' },
  });
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b4' }, page).ok, false);
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b5' }, page).ok, false);
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b9' }, page).ok, false);
  assert.deepEqual(parseLearnerAction({ action: 'click', targetId: 'b6' }, page), {
    ok: true,
    action: { action: 'click', targetId: 'b6' },
  });
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b2' }, snapshot).ok, false);
});

test('learner-rejects-submit', () => {
  const named = parseLearnerAction({ action: 'submit' }, snapshot);
  const clicked = parseLearnerAction({ action: 'click', targetId: 'b2' }, snapshot);
  assert.equal(named.ok, false);
  assert.equal(clicked.ok, false);
  if (!clicked.ok) assert.match(clicked.error, /submit/i);
});

test('learner-rejects-unknown-action', () => {
  const result = parseLearnerAction({ action: 'launch' }, snapshot);
  assert.equal(result.ok, false);
  assert.equal(parseLearnerAction({ action: 'scorm-complete' }, snapshot).ok, false);
  assert.equal(parseLearnerAction({ action: 'dance' }, snapshot).ok, false);
});

test('confirm-shortcut-refused-for-mutating-capability', () => {
  assert.equal(confirmShortcutAllowed('quiz-learn'), false);
  assert.equal(confirmShortcutAllowed('cert-batch'), false);
  assert.equal(confirmShortcutAllowed('list-tabs'), true);
});

test('quiz-learn-requires-confirmed-plan', () => {
  const missing = authorizeRun({
    script: 'pw-learn-quiz.js',
    args: ['0'],
    plan: null,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 403);
});

test('learner is not offered for a server assessment', () => {
  assert.equal(learnerOfferedFor('server-assessment'), false);
  assert.equal(learnerOfferedFor('scorm'), false);
  assert.equal(learnerOfferedFor('unknown'), true);
  assert.equal(learnerOfferedFor('document-wbt'), true);
  assert.equal(learnerOfferedFor('none'), true);
  assert.equal(learnerOfferedFor('csod-curriculum'), true);
  assert.equal(learnerOfferedFor('csod-learning'), true);
});

test('learner accepts a bounded ask-user question and rejects an invalid one', () => {
  const accepted = parseLearnerAction({
    action: 'ask-user',
    question: '  Which module should I open?  ',
    options: [' Module 1 ', 'Resume here', 'x'.repeat(120)],
  }, snapshot);
  assert.deepEqual(accepted, {
    ok: true,
    action: {
      action: 'ask-user',
      question: 'Which module should I open?',
      options: ['Module 1', 'Resume here', 'x'.repeat(120)],
    },
  });
  assert.equal(parseLearnerAction({ action: 'ask-user', question: 'y'.repeat(500) }, snapshot).ok, true);
  assert.equal(parseLearnerAction({ action: 'ask-user', question: 'y'.repeat(501) }, snapshot).ok, false);
  assert.equal(parseLearnerAction({ action: 'ask-user', question: '   ' }, snapshot).ok, false);
  assert.equal(parseLearnerAction({
    action: 'ask-user',
    question: 'Which module?',
    options: ['a', 'b', 'c', 'd'],
  }, snapshot).ok, false);
  assert.equal(parseLearnerAction({
    action: 'ask-user',
    question: 'Which module?',
    options: ['z'.repeat(121)],
  }, snapshot).ok, false);
  const decided = decideLearnerStep('{"action":"ask-user","question":"Open which question?"}', snapshot);
  assert.deepEqual(decided, { ok: true, action: { action: 'ask-user', question: 'Open which question?' } });
});

test('decideLearnerStep rejects a model submit and accepts a bounded wait', () => {
  const rejected = decideLearnerStep('{"action":"submit"}', snapshot);
  assert.equal(rejected.ok, false);
  const accepted = decideLearnerStep('Here is the action {"action":"wait","ms":9000}', snapshot);
  assert.deepEqual(accepted, { ok: true, action: { action: 'wait', ms: 1000 } });
});

test('quiz-result-passed records a verified learner result', () => {
  const result = classifyOutcome({
    script: 'pw-learn-quiz.js',
    code: 0,
    output: 'AUTOMATION_RESULT {"completed":1,"total":1}',
  });
  assert.equal(result.verified, true);
  assert.equal(result.outcome, 'success');
});
