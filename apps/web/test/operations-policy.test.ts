import assert from 'node:assert/strict';
import test from 'node:test';
import { idlePhase, OPERATOR_IDLE_MS, operationsPollDelay } from '../src/lib/operations-policy';

test('polling follows active work and slows down while idle, hidden or disconnected',()=>{
  const state={active:false,visible:true,paused:false,failed:false};
  assert.equal(operationsPollDelay(state),15_000);
  assert.equal(operationsPollDelay({...state,active:true}),3_000);
  assert.equal(operationsPollDelay({...state,active:true,visible:false}),60_000);
  assert.equal(operationsPollDelay({...state,paused:true}),60_000);
  assert.equal(operationsPollDelay({...state,failed:true}),30_000);
});
test('inactivity warns after 28 minutes and pauses after 30',()=>{
  assert.equal(OPERATOR_IDLE_MS,1_800_000);
  assert.equal(idlePhase(120_001),'active');
  assert.equal(idlePhase(120_000),'warning');
  assert.equal(idlePhase(1),'warning');
  assert.equal(idlePhase(0),'paused');
  assert.equal(idlePhase(-100),'paused');
});
