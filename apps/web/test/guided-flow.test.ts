import assert from 'node:assert/strict';
import test from 'node:test';
import { decideGuidedFlow, learnerQuestion, sameDetectedTarget, supportsGuidedLearning, uniqueQuestionTab } from '../src/lib/guided-flow';

test('uses actual detector capability IDs, including SCORM and SlickQuiz', () => {
  for (const [detected, capability] of [['scorm-player', 'scorm-complete'], ['slickquiz-exam', 'slickquiz-solve'], ['container', 'container-batch']]) {
    assert.equal(decideGuidedFlow({ detected, action: { capabilityId: capability } }).kind, 'run');
  }
  assert.equal(decideGuidedFlow({ detected: 'unknown', action: { capabilityId: 'close-browser' } }).kind, 'learn');
});

test('unknown and Canon curriculum begin learning; login and assessments pause', () => {
  for (const detected of ['unknown', 'document-wbt', 'csod-curriculum']) assert.equal(decideGuidedFlow({ detected }).kind, 'learn');
  for (const detected of ['session-dead', 'server-assessment', 'certification']) assert.equal(decideGuidedFlow({ detected }).kind, 'question');
});

test('only the exact inspected tab and URL can continue', () => {
  assert.equal(sameDetectedTarget({ tabIdx: 2, url: 'https://example.com/a' }, { index: 2, url: 'https://example.com/a' }), true);
  assert.equal(sameDetectedTarget({ tabIdx: 2, url: 'https://example.com/a' }, { index: 1, url: 'https://example.com/a' }), false);
  assert.equal(sameDetectedTarget({ tabIdx: 2, url: 'https://example.com/a' }, { index: 2, url: 'https://example.com/b' }), false);
});

test('question recovery accepts only bounded structured question markers', () => {
  assert.deepEqual(learnerQuestion('step\nLEARNER_QUESTION {"question":"Which module?","options":["A","B"]}\n'), { question: 'Which module?', options: ['A', 'B'] });
  assert.equal(learnerQuestion('LEARNER_QUESTION not-json'), null);
  assert.equal(learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ question: 'x'.repeat(501) })}`), null);
  assert.equal(learnerQuestion('{"question":"not a marker"}'), null);
});

test('learning requires the helper version containing capture and question fixes', () => {
  assert.equal(supportsGuidedLearning('1.0.7'), false);
  assert.equal(supportsGuidedLearning('1.0.8'), true);
  assert.equal(supportsGuidedLearning('1.0.10'), true);
  assert.equal(supportsGuidedLearning('invalid'), false);
});

test('question recovery carries the bounded pause URL rather than the launch page', () => {
  const paused = 'https://example.com/course/next';
  assert.deepEqual(learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ question: 'Which module?', options: ['A'], url: paused })}`), { question: 'Which module?', options: ['A'], url: paused });
  for (const url of ['', 'https://example.com/' + 'x'.repeat(500), 123, 'javascript:alert(1)']) {
    assert.equal(learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ question: 'Which module?', url })}`), null);
  }
});

test('resume resolves a new target ID only for one exact matching pause URL', () => {
  const tabs = [{ targetId: 'old', url: 'https://example.com/start' }, { targetId: 'new', url: 'https://example.com/pause' }];
  assert.equal(uniqueQuestionTab('https://example.com/pause', tabs)?.targetId, 'new');
  assert.equal(uniqueQuestionTab(undefined, tabs), null);
  assert.equal(uniqueQuestionTab('https://example.com/missing', tabs), null);
  assert.equal(uniqueQuestionTab('https://example.com/pause', [...tabs, { targetId: 'duplicate', url: 'https://example.com/pause' }]), null);
});
