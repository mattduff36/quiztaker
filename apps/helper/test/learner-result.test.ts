import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { structuredResult } from '../src/results.js';
import { readBrowserSession } from '../src/browser-session.js';

test('actual quiz score and negative result survive helper result transport',()=>{
  for(const status of ['passed','failed']) {
    const quizResult={status,scorePercent:75,passingScorePercent:70,questionsTotal:20,questionsCorrect:15,questionsIncorrect:5,evidence:['Test Results - Example Learner\nPass/Fail: '+status]};
    const result=structuredResult('quiz-learn','AUTOMATION_RESULT '+JSON.stringify({completed:status==='passed'?1:0,total:1,quizResult}),status==='passed'?0:1);
    assert.deepEqual((result.result as Record<string,unknown>).quizResult,quizResult);
    assert.equal(result.ok,status==='passed');
  }
});

test('learner pause refreshes the actual navigated page without claiming success', () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-pause-'));
  const previous = process.env.QUIZTAKER_HOME;
  process.env.QUIZTAKER_HOME = home;
  try {
    structuredResult('list-tabs', JSON.stringify([{idx:0,title:'Course',url:'https://example.com/course'}]), 0);
    const before = readBrowserSession()!;
    const result = structuredResult('quiz-learn', 'LEARNER_TABS ' + JSON.stringify([{idx:0,title:'Question',url:'https://example.com/question'}]), 1);
    const after = readBrowserSession()!;
    assert.equal(after.id,before.id);
    assert.equal(after.revision,before.revision+1);
    assert.equal(after.tabs[0].url,'https://example.com/question');
    assert.equal(result.ok,false);
    structuredResult('quiz-learn','LEARNER_TABS [{"idx":"invalid"}]',1);
    assert.deepEqual(readBrowserSession(),after);
  } finally {
    if(previous === undefined) delete process.env.QUIZTAKER_HOME; else process.env.QUIZTAKER_HOME=previous;
    rmSync(home,{recursive:true,force:true});
  }
});
