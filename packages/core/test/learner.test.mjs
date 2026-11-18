import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeRun,
  classifyOutcome,
  confirmShortcutAllowed,
  decideLearnerStep,
  learnerOfferedFor,
  parseLearnerAction,
  learnerConstraints,
  storedLearnerPolicy,
  learnerActions,
  getCapability,
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

test('grouped answers are quiz-only, page-bound, bounded, unique and contain no navigation',()=>{
  const view={answerPageId:'a'.repeat(64),choices:[
    {id:'c1',name:'A',groupId:'question-one',answerKind:'radio',checked:true},
    {id:'c2',name:'B',groupId:'question-one',answerKind:'radio'},
    {id:'k1',name:'C',groupId:'question-two',answerKind:'checkbox'}],buttons:[{id:'b1',name:'Submit'}]};
  const action={action:'answer-group',pageId:view.answerPageId,answers:[{targetId:'c1',checked:true},{targetId:'k1',checked:false}]};
  assert.equal(parseLearnerAction(action,view,{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction(action,view,{mode:'read'}).ok,false);
  assert.equal(parseLearnerAction({...action,pageId:'b'.repeat(64)},view,{mode:'quiz'}).ok,false);
  assert.equal(parseLearnerAction({...action,pageId:'invalid'},{...view,answerPageId:'invalid'},{mode:'quiz'}).ok,false);
  for(const answers of [[],Array(9).fill({targetId:'k1',checked:true}),[{targetId:'b1',checked:true}],
    [{targetId:'c1',checked:false}],[{targetId:'c1',checked:true},{targetId:'c2',checked:true}],
    [{targetId:'k1',checked:true},{targetId:'k1',checked:false}]]) {
    assert.equal(parseLearnerAction({...action,answers},view,{mode:'quiz'}).ok,false);
  }
});

test('ordinary course exits are reserved for the scoped terminal finalizer in every mode', () => {
  for (const name of ['Close module', 'CLOSE PLAYER', 'Exit course', 'Exit and finish', 'Close browser', 'Delete account']) {
    for (const mode of ['read', 'quiz']) {
      assert.equal(parseLearnerAction({ action: 'click', targetId: 'b1' }, { buttons: [{ id: 'b1', name, kind: 'content' }] }, { mode }).ok, false, `${mode}: ${name}`);
    }
  }
});

test('only browser-derived named course-player overlay controls are allowed, not arbitrary exits',()=>{
  for(const name of ['Course player: Exit','Course player: Confirm exit','Course player: Cancel exit']) {
    assert.equal(parseLearnerAction({action:'click',targetId:'b1'},{buttons:[{id:'b1',name,kind:'content'}]},{mode:'read'}).ok,true);
  }
  for(const name of ['Exit','Exit course','Course player: Delete']) {
    assert.equal(parseLearnerAction({action:'click',targetId:'b1'},{buttons:[{id:'b1',name,kind:'content'}]},{mode:'read'}).ok,false);
  }
});

test('observed repair matching options stay quiz-only even when their label says Remove',()=>{
  const view={buttons:[{id:'m1',name:'Remove the base enclosure',kind:'quiz-navigation'}]};
  assert.equal(parseLearnerAction({action:'click',targetId:'m1'},view,{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction({action:'click',targetId:'m1'},view,{mode:'read'}).ok,false);
});

test('written answers require the current observed field and quiz authorization',()=>{
  const action={action:'answer-text',targetId:'f1',text:'The socket pins are bent.'};
  const view={...snapshot,fields:[{id:'f1',name:'Type your answer'}]};
  assert.equal(parseLearnerAction(action,view,{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction(action,view,{mode:'read'}).ok,false);
  assert.equal(parseLearnerAction(action,snapshot,{mode:'quiz'}).ok,false);
  assert.equal(parseLearnerAction({...action,text:'x'.repeat(2001)},view,{mode:'quiz'}).ok,false);
});

test('question-bound Saba matching requires capability6 rather than an old capability5 plan', () => {
  const capability=getCapability('quiz-learn');assert.equal(capability.version,7);
  const plan={script:capability.script,capabilityId:capability.id,capabilityVersion:5,args:['0'],confirmed:true,consumed:false,expiresAt:new Date(Date.now()+60_000).toISOString()};
  assert.equal(authorizeRun({script:capability.script,args:['0'],plan}).ok,false);
  assert.equal(authorizeRun({script:capability.script,args:['0'],plan:{...plan,capabilityVersion:6}}).ok,false);
  assert.equal(authorizeRun({script:capability.script,args:['0'],plan:{...plan,capabilityVersion:7}}).ok,true);
});

test('matching uses existing quiz-only clicks and guards all unanswered fields',()=>{
  const view={buttons:[{id:'m1',name:'Repair step',kind:'quiz-navigation',selection:{value:'Select',answered:false}},{id:'m2',name:'Inspect the part',kind:'quiz-navigation'},{id:'b1',name:'Next',kind:'content'}]};
  assert.equal(parseLearnerAction({action:'click',targetId:'m1'},view,{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction({action:'click',targetId:'m2'},view,{mode:'read'}).ok,false);
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},view,{mode:'quiz'}).ok,false);
  view.buttons[0].selection={value:'Inspect the part',answered:true};
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},view,{mode:'quiz'}).ok,true);
});

test('browser tool contract validates direction/find text and repairs checked-answer or unanswered Next decisions', () => {
  assert.ok(learnerActions.has('find-text'));
  assert.deepEqual(parseLearnerAction({action:'scroll'},snapshot),{ok:true,action:{action:'scroll'}});
  assert.deepEqual(parseLearnerAction({action:'scroll',direction:'up'},snapshot),{ok:true,action:{action:'scroll',direction:'up'}});
  assert.equal(parseLearnerAction({action:'scroll',direction:'left'},snapshot).ok,false);
  assert.deepEqual(parseLearnerAction({action:'find-text',text:' paper grain '},snapshot),{ok:true,action:{action:'find-text',text:'paper grain'}});
  for(const text of ['', 'x'.repeat(161)])assert.equal(parseLearnerAction({action:'find-text',text},snapshot).ok,false);
  const page={text:'Question 1 of 20',buttons:[{id:'b1',name:'Next »',kind:'quiz-navigation'}],choices:[{id:'c1',name:'A',checked:false},{id:'c2',name:'B',checked:false}]};
  const unanswered=parseLearnerAction({action:'click',targetId:'b1'},page,{mode:'quiz'});
  assert.equal(unanswered.ok,false);assert.match(unanswered.error,/Select an answer/);
  page.choices[0].checked=true;
  const repeated=parseLearnerAction({action:'answer-select',targetId:'c1'},page,{mode:'quiz'});
  assert.equal(repeated.ok,false);assert.match(repeated.error,/already selected.*Next/);
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},page,{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},{...page,choices:[{id:'c1',name:'Legacy unknown'}]},{mode:'quiz'}).ok,true);
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},{...page,buttons:[{id:'b1',name:'Next',kind:'content'}],choices:[{id:'c1',name:'A',checked:false}]},{mode:'read'}).ok,true);
});

test('only stored quiz intent authorizes observed submission and semantic course controls', () => {
  const quiz = storedLearnerPolicy({mode:'quiz'}, learnerConstraints('quiz'));
  const page = { buttons:[{id:'b1',name:'Submit quiz',kind:'submission'},{id:'b2',name:'Next »',kind:'quiz-navigation'},{id:'b3',name:'Types of paper',kind:'content'}], choices:[] };
  for (const targetId of ['b1','b2']) {
    assert.equal(parseLearnerAction({action:'click',targetId},page,quiz).ok,true);
    assert.equal(parseLearnerAction({action:'click',targetId},{...page,mode:'quiz',submissionAuthorized:true}).ok,false);
  }
  assert.equal(parseLearnerAction({action:'click',targetId:'b3'},page).ok,true);
  assert.deepEqual(storedLearnerPolicy(null,null),{mode:'read'});
  assert.throws(()=>storedLearnerPolicy({mode:'quiz'},learnerConstraints()),/not authorized/);
  assert.throws(()=>storedLearnerPolicy({mode:'read'},learnerConstraints('quiz')),/does not match/);
  assert.equal(learnerOfferedFor('server-assessment','quiz'),true);
});

test('combined intent requires matching stored assessment authorization', () => {
  const input = { mode: 'quiz', intent: 'read-and-assess' };
  const constraints = learnerConstraints('quiz', input.intent);
  const policy = storedLearnerPolicy(input, constraints);
  assert.deepEqual(policy, input);
  const page = { buttons: [
    { id: 'b1', name: 'Read lesson', kind: 'content' },
    { id: 'b2', name: 'Submit assessment', kind: 'submission' },
  ] };
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b1' }, page, policy).ok, true);
  assert.equal(parseLearnerAction({ action: 'click', targetId: 'b2' }, page, policy).ok, true);
  assert.throws(() => storedLearnerPolicy(input, learnerConstraints('quiz')), /intent does not match/);
  assert.throws(() => storedLearnerPolicy(input, { ...constraints, submissionAuthorized: false }), /not authorized/);
  assert.throws(() => learnerConstraints('read', input.intent), /invalid for this mode/);
});

test('tab switching requires an observed same-website course tab', () => {
  const page = {url:'https://example.com/course',tabs:[{id:'t1',name:'Paper quiz',url:'https://example.com/quiz'}]};
  assert.equal(parseLearnerAction({action:'select-tab',targetId:'t1'},page).ok,true);
  assert.equal(parseLearnerAction({action:'select-tab',targetId:'t2'},page).ok,false);
  assert.equal(parseLearnerAction({action:'select-tab',targetId:'t1'},{...page,tabs:[{id:'t1',name:'Paper quiz',url:'https://other.com/quiz'}]}).ok,false);
});

test('observed answer labels are facts, while clicks and assessment starts obey mode', () => {
  for (const name of ['Password','Delete','Exit','Account']) {
    const page = {choices:[{id:'c1',name}],buttons:[{id:'b1',name,kind:'content'}]};
    assert.equal(parseLearnerAction({action:'answer-select',targetId:'c1'},page,{mode:'quiz'}).ok,true);
    assert.equal(parseLearnerAction({action:'click',targetId:'b1'},page,{mode:'quiz'}).ok,false);
  }
  assert.equal(parseLearnerAction({action:'click',targetId:'b1'},{buttons:[{id:'b1',name:'Home'}]}).ok,true);
  for(const name of ['Start Quiz','Begin the Test','Launch Assessment','Retake','Retry quiz']) {
    const page = {buttons:[{id:'b1',name,kind:'content'}]};
    assert.equal(parseLearnerAction({action:'click',targetId:'b1'},page).ok,false);
    assert.equal(parseLearnerAction({action:'click',targetId:'b1'},page,{mode:'quiz'}).ok,true);
  }
});

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

test('learner normalizes one action wrapper and keeps current-target and submit guards', () => {
  const page = {
    buttons: [
      { id: 'b1', name: 'Next' },
      { id: 'b2', name: 'Submit' },
    ],
    choices: snapshot.choices,
  };
  assert.deepEqual(parseLearnerAction({ action: 'click', targetId: 'b1' }, page), {
    ok: true,
    action: { action: 'click', targetId: 'b1' },
  });
  assert.deepEqual(parseLearnerAction({
    action: { action: 'click', targetId: 'b1' },
    stop: false,
    error: null,
  }, page), {
    ok: true,
    action: { action: 'click', targetId: 'b1' },
  });
  const wrappedSubmit = parseLearnerAction({ action: { action: 'submit' }, stop: false, error: null }, page);
  assert.equal(wrappedSubmit.ok, false);
  if (!wrappedSubmit.ok) assert.match(wrappedSubmit.error, /not allowed/i);
  const wrappedSubmitClick = parseLearnerAction({ action: { action: 'click', targetId: 'b2' } }, page);
  assert.equal(wrappedSubmitClick.ok, false);
  if (!wrappedSubmitClick.ok) assert.match(wrappedSubmitClick.error, /submit/i);
  const wrappedUnknown = parseLearnerAction({ action: { action: 'dance' } }, page);
  assert.equal(wrappedUnknown.ok, false);
  if (!wrappedUnknown.ok) assert.match(wrappedUnknown.error, /not allowed/i);
  const missingTarget = parseLearnerAction({ action: { action: 'click' }, stop: false }, page);
  assert.equal(missingTarget.ok, false);
  if (!missingTarget.ok) assert.match(missingTarget.error, /target/i);
  const absentTarget = parseLearnerAction({ action: { action: 'click', targetId: 'b9' } }, page);
  assert.equal(absentTarget.ok, false);
  if (!absentTarget.ok) assert.match(absentTarget.error, /not on the page/i);
  const recursive = parseLearnerAction({ action: { action: { action: 'click', targetId: 'b1' } } }, page);
  assert.equal(recursive.ok, false);
  if (!recursive.ok) assert.match(recursive.error, /not allowed/i);
  assert.deepEqual(decideLearnerStep('{"action":{"action":"click","targetId":"b1"},"stop":false}', page), {
    ok: true,
    action: { action: 'click', targetId: 'b1' },
  });
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
