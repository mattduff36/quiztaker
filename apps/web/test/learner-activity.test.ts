import assert from 'node:assert/strict';
import test from 'node:test';
import { LEARNER_ACTIVITY_LIMIT, learnerActivityUpdates } from '../src/lib/learner-activity.js';

test('malformed learner progress is ignored and step lines stay factual', () => {
  const output = [
    'LEARNER_PROGRESS',
    'LEARNER_PROGRESS {',
    'LEARNER_PROGRESS {"message":',
    'LEARNER_PROGRESS {"message":1}',
    'LEARNER_PROGRESS {"message":""}',
    'LEARNER_PROGRESS {"message":"   "}',
    'LEARNER_PROGRESS {"note":"secret reasoning"}',
    'LEARNER_PROGRESS {"message":"{\\"chain\\":\\"of thought\\"}"}',
    '{"message":"not a progress line"}',
    'chain of thought: consider every option before clicking',
    'Learner step x: click',
    'Learner step 3:',
    'Learner step 2: {"action":"click"}',
    'LEARNER_PROGRESS {"message":"Reading the module list","reasoning":"hidden"}',
    'Learner step 4: click',
    'Learner step 5: mystery-action',
    'Learner step 6: page does not show a pass',
    `LEARNER_PROGRESS {"message":"${'x'.repeat(241)}"}`,
  ].join('\n');
  assert.deepEqual(learnerActivityUpdates(output), [
    'Reading the module list',
    'Step 4: Selecting a control',
    'Step 5: In progress',
    'Step 6: The page does not show completion yet',
  ]);
  assert.equal(JSON.stringify(learnerActivityUpdates(output)).includes('secret'), false);
  assert.equal(JSON.stringify(learnerActivityUpdates(output)).includes('mystery-action'), false);
  assert.equal(JSON.stringify(learnerActivityUpdates(output)).includes('chain'), false);
});

test('activity keeps the latest concise updates', () => {
  const lines = Array.from({ length: LEARNER_ACTIVITY_LIMIT + 2 }, (_, index) => (
    `LEARNER_PROGRESS ${JSON.stringify({ message: `Update ${index}` })}`
  ));
  const updates = learnerActivityUpdates(lines.join('\r\n'));
  assert.equal(updates.length, LEARNER_ACTIVITY_LIMIT);
  assert.equal(updates[0], 'Update 2');
  assert.equal(updates.at(-1), `Update ${LEARNER_ACTIVITY_LIMIT + 1}`);
});

test("zero progress limit hides all updates", () => { assert.deepEqual(learnerActivityUpdates('LEARNER_PROGRESS {"message":"Reading"}', 0), []); });
