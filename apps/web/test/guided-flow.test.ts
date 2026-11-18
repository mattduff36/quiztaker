import assert from 'node:assert/strict';
import test from 'node:test';
import { decideGuidedFlow, independentIntent, learnerQuestion, learnerStopMessage, observedQuizResult, sameDetectedTarget, supportsGuidedLearning, uniqueQuestionTab, questionTargetTab } from '../src/lib/guided-flow';

test('named retake exclusions and optional review do not veto a separate explicit assessment',()=>{
  assert.equal(independentIntent('Do not retake Device Features. Read the Firmware course, then pass the Firmware assessment. Review if needed.'),'read-and-assess');
  assert.equal(independentIntent('Read the course. If needed review the diagrams. Take the final quiz.'),'read-and-assess');
  assert.equal(independentIntent('Read only. Take the quiz.'),'read');
  assert.equal(independentIntent('Read the lessons and do not submit any assessment.'),'read');
  assert.equal(independentIntent('If needed take the quiz.'),null);
});

test('an interrupted job cannot resurrect an earlier question marker',()=>{
  const question='LEARNER_QUESTION {"question":"Old answered request","url":"https://example.com/course"}\n';
  assert.equal(learnerQuestion(question+'Learner input timed out'),null);
  assert.equal(learnerQuestion(question+'AUTOMATION_RESULT {"ok":false,"failures":[{"reason":"learner-interrupted"}]}'),null);
  assert.match(learnerStopMessage('Learner input timed out')||'',/Resume from the current page/);
});

test('ordinary optional wording does not erase an explicit assessment goal and Saba course pages can launch',()=>{
  assert.equal(independentIntent('Read the course, then take the assessment. Review the material again if needed.'),'read-and-assess');
  assert.equal(independentIntent('Read the course and tell me whether I should take the assessment'),null);
  assert.equal(decideGuidedFlow({detected:'class-detail'},'read-and-assess').kind,'learn');
});

test('uses actual detector capability IDs, including SCORM and SlickQuiz', () => {
  for (const [detected, capability] of [['scorm-player', 'scorm-complete'], ['slickquiz-exam', 'slickquiz-solve'], ['container', 'container-batch']]) {
    assert.equal(decideGuidedFlow({ detected, action: { capabilityId: capability } }).kind, 'learn');
  }
  assert.equal(decideGuidedFlow({ detected: 'unknown', action: { capabilityId: 'close-browser' } }).kind, 'learn');
});

test('reports the observed quiz score separately from course completion', () => {
  assert.deepEqual(observedQuizResult({ result: { quizResult: { status: 'passed', scorePercent: 91, passingScorePercent: 80 } } }), {
    heading: 'Quiz passed · 91%',
    detail: 'Pass mark 80%. Check the course progress in the learning portal and finish any remaining lessons.',
  });
  assert.equal(observedQuizResult({ result: { quizResult: { status: 'verified' } } }), null);
});

test('unknown and Canon curriculum begin learning; login and assessments pause', () => {
  for (const detected of ['unknown', 'document-wbt', 'csod-curriculum']) assert.equal(decideGuidedFlow({ detected }).kind, 'learn');
  for (const detected of ['session-dead', 'server-assessment', 'certification', 'cert-landing']) assert.equal(decideGuidedFlow({ detected }).kind, 'question');
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
  assert.equal(supportsGuidedLearning('1.0.8'), false);
  assert.equal(supportsGuidedLearning('1.0.10'), false);
  assert.equal(supportsGuidedLearning('invalid'), false);
});

test('question recovery carries the bounded pause URL rather than the launch page', () => {
  const paused = 'https://example.com/course/next?' + 'x'.repeat(1100);
  assert.deepEqual(learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ question: 'Which module?', options: ['A'], url: paused })}`), { question: 'Which module?', options: ['A'], url: paused });
  for (const url of ['', 'https://example.com/' + 'x'.repeat(2000), 123, 'javascript:alert(1)']) {
    assert.equal(learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ question: 'Which module?', url })}`), null);
  }
});

test('independent goals select a plan and leave ambiguous submission for the operator', () => {
  assert.equal(independentIntent('Read the material without taking the quiz'), 'read');
  assert.equal(independentIntent('Take the quiz'), 'quiz');
  assert.equal(independentIntent('Complete the lessons then pass the assessment'), 'read-and-assess');
  assert.equal(independentIntent('Read the course then take the quiz'), 'read-and-assess');
  assert.equal(independentIntent('Complete the course'), null);
  assert.equal(independentIntent('Explain how to pass the quiz'), null);
});

test('resume resolves a new target ID only for one exact matching pause URL', () => {
  const tabs = [{ targetId: 'old', url: 'https://example.com/start' }, { targetId: 'new', url: 'https://example.com/pause' }];
  assert.equal(uniqueQuestionTab('https://example.com/pause', tabs)?.targetId, 'new');
  assert.equal(uniqueQuestionTab(undefined, tabs), null);
  assert.equal(uniqueQuestionTab('https://example.com/missing', tabs), null);
  assert.equal(uniqueQuestionTab('https://example.com/pause', [...tabs, { targetId: 'duplicate', url: 'https://example.com/pause' }]), null);
});

test('identical curriculum titles and redacted URLs never rebind a paused selection',()=>{
  const url='https://canon-europe.csod.com/ui/lms-learning-details/app/curriculum';
  const tabs=[{targetId:'a',cdpTargetId:'live-a',url,title:'Curriculum'},{targetId:'b',cdpTargetId:'live-b',url,title:'Curriculum'}];
  const question={url,cdpTargetId:'live-b'};
  assert.equal(questionTargetTab(question,tabs)?.targetId,'b');
  assert.equal(questionTargetTab({url,targetId:'b'},tabs)?.targetId,'b');
  assert.equal(questionTargetTab({url},tabs,'a')?.targetId,'a');
  assert.equal(questionTargetTab({url},tabs),null);
  assert.equal(questionTargetTab(question,[tabs[0],{...tabs[1],url:'https://canon-europe.csod.com/transition'}]),null,'actual URL change invalidates paused answers');
  assert.equal(questionTargetTab(question,[tabs[0],{...tabs[1],targetId:'c',cdpTargetId:'live-c'}]),null,'closed/reopened tab is not rebound');
  const marker=learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({...question,question:'Which course?'})}`);
  assert.equal(marker?.cdpTargetId,'live-b');
});

test('quiz intent permits a server assessment while read intent never fast completes', () => {
  assert.equal(decideGuidedFlow({ detected: 'server-assessment' }, 'quiz').kind, 'learn');
  assert.equal(decideGuidedFlow({ detected: 'scorm-player', action: {capabilityId:'scorm-complete'} }, 'read').kind, 'learn');
  assert.equal(supportsGuidedLearning('1.0.15'), true);
});

test('combined guided mode uses the learner for both course material and assessments', () => {
  const onCourse = decideGuidedFlow({ detected: 'scorm-player', action: { capabilityId: 'scorm-complete' } }, 'read-and-assess');
  assert.deepEqual(onCourse, { kind: 'learn', message: 'Reading the course material and using it to answer assessment questions.' });
  assert.equal(decideGuidedFlow({ detected: 'server-assessment' }, 'read-and-assess').kind, 'learn');
  assert.equal(decideGuidedFlow({ detected: 'session-dead' }, 'read-and-assess').kind, 'question');
});

test('a blocked course control has a readable explanation for both old and new helper output', () => {
  const legacy = 'locator.click: Timeout 5000ms exceeded.\nSVG intercepts pointer events';
  const structured = 'AUTOMATION_RESULT {"failures":[{"reason":"blocked-control"}]}';
  assert.match(learnerStopMessage(legacy) ?? '', /could not click the course control/);
  assert.equal(learnerStopMessage(legacy), learnerStopMessage(structured));
  assert.equal(learnerStopMessage('Unrecognised output'), null);
});
