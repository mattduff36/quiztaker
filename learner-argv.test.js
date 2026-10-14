const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLearnQuizArgs, localActionAllowed, pageShowsPass } = require('./pw-learn-quiz');

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

test('page evidence decides a pass instead of the model', () => {
  assert.equal(pageShowsPass({ text: 'Question 1 of 10' }), false);
  assert.equal(pageShowsPass({ text: 'You have not passed' }), false);
  assert.equal(pageShowsPass({ text: 'Successful completion requires 80%' }), false);
  assert.equal(pageShowsPass({ text: 'Progress 100%' }), false);
  assert.equal(pageShowsPass({ title: 'Result', text: 'You passed this quiz' }), true);
  assert.equal(pageShowsPass({ text: 'Your score: 100%' }), true);
});
