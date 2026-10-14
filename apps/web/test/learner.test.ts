import assert from 'node:assert/strict';
import test from 'node:test';
import { learnerIsEnabled, learnerModelChain, learnerPrefersCursor, requestLearnerDecision } from '../src/lib/learner.js';

const snapshot = {
  buttons: [{ id: 'b1', name: 'Next' }],
  choices: [{ id: 'c1', name: 'The reservoir answer' }],
};

test('learner stays stopped when no API key is configured', async () => {
  const result = await requestLearnerDecision({ apiKey: undefined, snapshot });
  assert.equal(result.stop, true);
  assert.match(result.error || '', /API key/);
});

test('learner rejects a submit action returned by the model', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"submit"}' } }],
    })),
  });
  assert.equal(result.stop, true);
  assert.equal(result.action, undefined);
});

test('gemini uses later flash models when no backup list is configured', () => {
  assert.deepEqual(learnerModelChain({
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }), [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
  ]);
  assert.deepEqual(learnerModelChain({
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
  }), ['gpt-4o-mini']);
});

test('learner captures the page when every model stays busy', async () => {
  let calls = 0;
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    models: ['gemini-3.8-flash', 'gemini-2.5-flash'],
    snapshot,
    fetchImpl: async () => {
      calls += 1;
      return new Response('busy', { status: 503 });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.action, { action: 'capture' });
});

test('learner tries the next model when the first is busy', async () => {
  const seen: string[] = [];
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    models: ['gemini-3.8-flash', 'gemini-2.5-flash'],
    snapshot,
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      seen.push(model);
      if (model === 'gemini-3.8-flash') return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"wait","ms":500}' } }],
      }));
    },
  });
  assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-2.5-flash']);
  assert.deepEqual(result.action, { action: 'wait', ms: 500 });
});

test('local development prefers Cursor and hosted runs do not', () => {
  assert.equal(learnerPrefersCursor({
    nodeEnv: 'development',
    cursorApiKey: 'cursor-key',
  }), true);
  assert.equal(learnerPrefersCursor({
    nodeEnv: 'development',
    vercel: '1',
    cursorApiKey: 'cursor-key',
  }), false);
  assert.equal(learnerPrefersCursor({
    nodeEnv: 'production',
    cursorApiKey: 'cursor-key',
  }), false);
  assert.equal(learnerIsEnabled({ nodeEnv: 'development', cursorApiKey: 'cursor-key' }), true);
  assert.equal(learnerIsEnabled({ nodeEnv: 'production', learnerApiKey: 'gemini-key' }), true);
  assert.equal(learnerIsEnabled({ nodeEnv: 'production' }), false);
});

test('learner uses Cursor and does not call Gemini', async () => {
  let calls = 0;
  const result = await requestLearnerDecision({
    apiKey: 'gemini-key',
    snapshot,
    fetchImpl: async () => {
      calls += 1;
      return new Response('unused', { status: 500 });
    },
    cursor: async () => ({ action: { action: 'wait', ms: 500 } }),
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.action, { action: 'wait', ms: 500 });
});

test('learner stops when Cursor fails instead of spending Gemini', async () => {
  let calls = 0;
  const result = await requestLearnerDecision({
    apiKey: 'gemini-key',
    snapshot,
    fetchImpl: async () => {
      calls += 1;
      return new Response('unused', { status: 500 });
    },
    cursor: async () => { throw new Error('Cursor learner did not start'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.stop, true);
  assert.match(result.error || '', /did not start/);
});

test('learner returns an allowlisted answer selection', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"answer-select","targetId":"c1"}' } }],
    })),
  });
  assert.deepEqual(result.action, { action: 'answer-select', targetId: 'c1' });
});
