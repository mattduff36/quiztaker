import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserRefreshGate} from '../src/lib/browser-refresh-policy';
import {completedCourseTask} from '../src/lib/task-followup-policy';
test('refresh compares once per return and only after a fresh heartbeat; paused and busy keep the comparison pending',()=>{
 const gate=new BrowserRefreshGate();const base={paused:false,busy:false,visible:true,focused:true,heartbeat:'one',helperToken:'a',snapshotToken:'a'};
 assert.equal(gate.check(base),false);
 assert.equal(gate.check({...base,helperToken:'b'}),false);
 gate.activate('one');assert.equal(gate.check({...base,helperToken:'b'}),false);
 assert.equal(gate.check({...base,heartbeat:'two',helperToken:'b',paused:true}),false);
 assert.equal(gate.check({...base,heartbeat:'two',helperToken:'b',busy:true}),false);
 assert.equal(gate.check({...base,heartbeat:'two',helperToken:'b',visible:false}),false);
 assert.equal(gate.check({...base,heartbeat:'two',helperToken:'b'}),true);
 assert.equal(gate.check({...base,heartbeat:'three',helperToken:'c'}),false);
});
test('only successful task evidence can arm completion; maintenance, failures and questions cannot',()=>{
 for(const status of ['failed','cancelled','awaiting-input','running'])assert.equal(completedCourseTask({status,capability_id:'quiz-learn',outcome:{verified:true}}),false);
 assert.equal(completedCourseTask({status:'completed',capability_id:'list-tabs',outcome:{verified:true}}),false);
 assert.equal(completedCourseTask({status:'completed',capability_id:'quiz-learn',outcome:{verified:false}}),false);
 assert.equal(completedCourseTask({status:'completed',capability_id:'quiz-learn',outcome:{verified:true}}),true);
 assert.equal(completedCourseTask({status:'completed',capability_id:'quiz-learn',outcome:{operatorResolution:{result:'completed'}}}),true);
});
