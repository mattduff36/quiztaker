const test = require('node:test');
const assert = require('node:assert/strict');
const { recognizeQuizResult, quizResultPayload } = require('./lib/quiz-result');

const canon = 'Test Results\nQuestions on Test20\nQuestions Correct15\nQuestions Incorrect5\nPercent Correct75%\nPassing Score70%\nPass/Fail: Passed\nOverall Score75%(15 out of20)';

test('Canon summary preserves actual result, score, counts and pass threshold', () => {
  const result = recognizeQuizResult({text: canon});
  assert.deepEqual(result, {status:'passed', evidence:[canon], scorePercent:75, passingScorePercent:70, questionsTotal:20, questionsCorrect:15, questionsIncorrect:5});
  assert.deepEqual(quizResultPayload(result), {completed:1,total:1,quizResult:result});
  assert.equal(recognizeQuizResult({text:canon.replace('Test Results','Test Results - Example Learner')}).status,'passed');
  const splitLabels = canon.replace(/(Test|Correct|Incorrect)(\d)/g,'$1\n$2').replace('Pass/Fail: Passed','Pass/Fail:\nPassed');
  assert.equal(recognizeQuizResult({text:splitLabels}).scorePercent,75);
});

test('failed results and negative contradictions win and use existing failure contract', () => {
  for (const text of [canon.replace('Passed','Failed'), canon.replace('75%','65%'), `${canon}\nStatus: Failed`, 'Quiz result\nYou have not passed. Your score: 100%']) {
    const result = recognizeQuizResult({text});
    assert.equal(result.status,'failed');
    assert.equal(quizResultPayload(result).completed,0);
    assert.equal(quizResultPayload(result).failures[0].reason,'quiz-failed');
    assert.deepEqual(quizResultPayload(result).failures[0].evidence,result.evidence);
  }
  assert.equal(recognizeQuizResult({resultViews:[canon,'Quiz result\nYou did not pass.']}).status,'failed');
});

test('instruction, review, active questions, page titles and retained memory cannot prove a result', () => {
  for (const snapshot of [
    {text:'You will see:\nYou passed this quiz'},
    {text:'Instructions\nTest Results\nStatus: Passed'},
    {text:`Previous results\n${canon}`},
    {text:`Review questions\n${canon}`},
    {text:`Question 4 of 20\n${canon}`},
    {text:canon,choices:[{id:'c1',name:'Passed'}]},
    {title:'You passed this quiz',text:'Current lesson'},
    {text:'Your score: 100%'},
    {text:canon,resultViews:['Current lesson'],outlines:[{topics:[canon]}]},
    {text:'Passing score: 70%'},
  ]) assert.equal(recognizeQuizResult(snapshot),null,JSON.stringify(snapshot));
  assert.equal(recognizeQuizResult({text:'Quiz result\nYou passed this quiz. Your score: 75%'}).scorePercent,75);
  assert.equal(recognizeQuizResult({text:'Test Results\nOverall Score75%(15 out of20)\nStatus: Passed'}).questionsCorrect,15);
});
