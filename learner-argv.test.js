const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLearnQuizArgs,
  localActionAllowed,
  pageShowsPass,
  learnerQuestionPayload,
  learnerQuestionLine,
  LEARNER_NEEDS_INPUT,
} = require('./pw-learn-quiz');

test('learn quiz argv accepts a tab index and dry run only', () => {
  assert.deepEqual(parseLearnQuizArgs(['node', 'pw-learn-quiz.js', '2']), { tabIdx: 2, dryRun: false });
  assert.deepEqual(parseLearnQuizArgs(['node', 'pw-learn-quiz.js', '2', '--dry']), { tabIdx: 2, dryRun: true });
  assert.throws(() => parseLearnQuizArgs(['node', 'pw-learn-quiz.js', '2', '--url', 'https://example.com']), /Only --dry/);
  assert.throws(() => parseLearnQuizArgs(['node', 'pw-learn-quiz.js']), /Usage/);
});

test('local learner guard refuses submit labels and unknown actions', () => {
  const snapshot = {
    buttons: [{ id: 'b1', name: 'Next' }, { id: 'b2', name: 'Finish' }],
    choices: [{ id: 'c1', name: 'Answer' }],
  };
  assert.equal(localActionAllowed({ action: 'click', targetId: 'b1' }, snapshot), true);
  assert.equal(localActionAllowed({ action: 'click', targetId: 'b2' }, snapshot), false);
  assert.equal(localActionAllowed({ action: 'exit' }, snapshot), false);
  assert.equal(localActionAllowed({ action: 'answer-select', targetId: 'c1' }, snapshot), true);
  assert.equal(localActionAllowed({ action: 'click', targetId: 'b1' }, {
    buttons: [{ id: 'b1', name: 'Save progress' }],
    choices: [],
  }), false);
});

test('no usable controls ask the operator to open the module and resume', () => {
  const empty = { buttons: [], choices: [] };
  const payload = learnerQuestionPayload(empty, null);
  assert.deepEqual(payload, { question: 'Open the intended question or module, then resume.' });
  const line = learnerQuestionLine(payload);
  assert.equal(line, 'LEARNER_QUESTION {"question":"Open the intended question or module, then resume."}');
  assert.equal(JSON.parse(line.slice('LEARNER_QUESTION '.length)).question, payload.question);
  assert.equal(LEARNER_NEEDS_INPUT, 'needs-user-input');
  assert.equal(learnerQuestionPayload({
    buttons: [{ id: 'b1', name: 'Next' }],
    choices: [],
  }, null), null);
});

test('ask-user is a bounded question and never a completion action', () => {
  const snapshot = {
    buttons: [{ id: 'b1', name: 'Next' }],
    choices: [{ id: 'c1', name: 'Answer' }],
  };
  const payload = learnerQuestionPayload(snapshot, {
    action: 'ask-user',
    question: ' Which question is open? ',
    options: [' Question 1 ', 'Question 2'],
  });
  assert.deepEqual(payload, {
    question: 'Which question is open?',
    options: ['Question 1', 'Question 2'],
  });
  assert.match(learnerQuestionLine(payload), /^LEARNER_QUESTION \{/);
  assert.equal(localActionAllowed({ action: 'ask-user', question: 'Which question is open?' }, snapshot), true);
  assert.equal(localActionAllowed({ action: 'ask-user', question: 'q'.repeat(501) }, snapshot), false);
  assert.equal(localActionAllowed({
    action: 'ask-user',
    question: 'Which?',
    options: ['a', 'b', 'c', 'd'],
  }, snapshot), false);
  assert.equal(localActionAllowed({
    action: 'ask-user',
    question: 'Which?',
    options: ['o'.repeat(121)],
  }, snapshot), false);
});

test('page evidence decides a pass instead of the model', () => {
  assert.equal(pageShowsPass({ text: 'Question 1 of 10' }), false);
  assert.equal(pageShowsPass({ text: 'You have not passed' }), false);
  assert.equal(pageShowsPass({ text: 'Successful completion requires 80%' }), false);
  assert.equal(pageShowsPass({ text: 'Progress 100%' }), false);
  assert.equal(pageShowsPass({ title: 'Result', text: 'You passed this quiz' }), true);
  assert.equal(pageShowsPass({ text: 'Your score: 100%' }), true);
});


test('embedded course navigation includes visible link buttons and skips hidden controls', async () => {
  const { readControls } = require('./pw-learn-quiz');
  function control(name, visible = true, submit = false) {
    return { isVisible: async () => visible, isEnabled: async () => true,
      getAttribute: async () => name, evaluate: async () => submit };
  }
  const controls = [control('Start'), control('Next', false), control('Finish'), control('Continue', true, true)];
  const content = { parentFrame: () => ({}), frameElement: async () => ({ isVisible: async () => true }),
    locator: (selector) => { assert.match(selector, /a,/); return { count: async () => controls.length, nth: (i) => controls[i] }; } };
  const hidden = { parentFrame: () => ({}), frameElement: async () => ({ isVisible: async () => false }), locator: () => { throw new Error('Hidden tracking frame must not be read'); } };
  const result = await readControls({ frames: () => [hidden, content] }, 'button', 'b', true);
  assert.deepEqual(result.listed, [{ id: 'b1', name: 'Start' }]);
  assert.equal(result.handles.get('b1'), controls[0]);
});
