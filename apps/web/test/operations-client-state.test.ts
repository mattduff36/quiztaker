import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTaskJob, isRunningJob, isTaskJob, retainTaskJob } from '../src/lib/operations-client-state';

test('shared learner capability does not mislabel reading as a quiz', () => {
  assert.equal(describeTaskJob({capability_id:'quiz-learn',status:'running'}), 'Course activity: Working');
});

test('maintenance observations and empty context preserve the task that owns a question', () => {
  const task = {id:'question',capability_id:'quiz-learn',status:'completed'};
  assert.equal(retainTaskJob(task, {id:'refresh',capability_id:'list-tabs',status:'running'}), task);
  assert.equal(retainTaskJob(task, null), task);
  const next = {id:'next',capability_id:'detect',status:'running'};
  assert.equal(retainTaskJob(task, next), next);
  assert.equal(isRunningJob(next), true);
  assert.equal(isRunningJob(task), false);
});

test('guided inspection and capture can be resolved as tasks; browser housekeeping cannot', () => {
  for (const capability_id of ['detect','learn-capture','quiz-learn','cert-batch']) assert.equal(isTaskJob({capability_id}), true);
  for (const capability_id of ['list-tabs','cdp-check','fit-tab','start-browser','close-browser','open-url','cert-status','cert-dry-run','tab-inspect']) assert.equal(isTaskJob({capability_id}), false);
});
