import test from 'node:test';
import assert from 'node:assert/strict';
import {jobOutput} from '../src/lib/job-output';
import {learnerQuestion} from '../src/lib/guided-flow';

test('a question emitted after a progress event without a newline remains visible and target-bound',()=>{
 const output=jobOutput([
  {data:{text:'LEARNER_PROGRESS {"message":"Reading course"}'}},
  {data:{text:'LEARNER_TABS []\n'}},
  {data:{text:'LEARNER_QUESTION {"question":"Open Launch course?","options":["Done"],"url":"https://example.com/course","cdpTargetId":"ABC123"}\n'}},
  {data:{text:'AUTOMATION_RESULT {"ok":false,"failures":[{"reason":"needs-user-input"}]}'}}
 ]);
 assert.deepEqual(learnerQuestion(output),{question:'Open Launch course?',options:['Done'],url:'https://example.com/course',cdpTargetId:'ABC123'});
 assert.equal(learnerQuestion(output+'\nAUTOMATION_RESULT {"ok":false,"failures":[{"reason":"learner-interrupted"}]}'),null);
});

test('ordinary split stdout and split JSON chunks are preserved; malformed questions stay rejected',()=>{
 assert.equal(jobOutput([{data:{text:'partial '}},{data:{text:'line'}},{data:{text:'\nnext'}}]),'partial line\nnext');
 assert.equal(jobOutput([{data:{text:'LEARNER_QUESTION {"question":'}},{data:{text:'"Ready?"}\n'}}]),'LEARNER_QUESTION {"question":"Ready?"}\n');
 assert.equal(learnerQuestion(jobOutput([{data:{text:'progress'}},{data:{text:'LEARNER_QUESTION {"question":"Ready?","url":"javascript:bad"}'}}])),null);
});

test('a fresh fallback question after a chat timeout is visible, but an older question stays expired',()=>{
 const question='LEARNER_QUESTION {"question":"Chat disconnected. Connect it or choose Work independently."}';
 const timeout='ChatGPT coordination timed out or disconnected.';
 assert.ok(learnerQuestion(jobOutput([{data:{text:timeout}},{data:{text:question}},{data:{text:'AUTOMATION_RESULT {"ok":false,"failures":[{"reason":"needs-user-input"}]}'}}])));
 assert.equal(learnerQuestion(question+'\n'+timeout),null);
});
