import assert from 'node:assert/strict';
import test from 'node:test';
import {historyResult} from '../src/lib/history-result';

test('legacy object badges recover the final status from retained evidence',()=>{
  assert.equal(historyResult('[object Object]',{result:{before:{lesson_status:'incomplete'},after:{'cmi.core.lesson_status':'passed'}}}),'passed');
  assert.equal(historyResult({before:{status:'passed'},after:{status:'failed'}}),'failed');
  assert.equal(historyResult('[object Object]',{result:{after:{completion_status:'completed'}}}),'completed');
});
test('unknown or malformed results never display objects or fabricate a pass',()=>{
  assert.equal(historyResult({unexpected:{text:'passed'}}),'Not recorded');
  assert.equal(historyResult('{invalid}'),'Not recorded');
  assert.equal(historyResult(100),'Score: 100');
  assert.equal(historyResult('operator-completed'),'operator-completed');
  const circular:Record<string,unknown>={};circular.result=circular;
  assert.equal(historyResult(circular),'Not recorded');
});
