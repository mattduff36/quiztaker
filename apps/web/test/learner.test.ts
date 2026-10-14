import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLearnerDetectionMatch, LEARNER_SYSTEM_PROMPT, learnerGuidanceText, learnerIsEnabled, learnerModelChain, learnerPrefersCursor, requestLearnerDecision } from '../src/lib/learner.js';

const snapshot = {
  buttons: [{ id: 'b1', name: 'Next' }],
  choices: [{ id: 'c1', name: 'The reservoir answer' }],
};

test('learner stays stopped when no API key is configured', async () => {
  const result = await requestLearnerDecision({ apiKey: undefined, snapshot });
  assert.equal(result.stop, true);
  assert.match(result.error || '', /API key/);
});

test('learner asks which current control to use instead of running a submit action', async () => {
  let calls = 0;
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: {
      ...snapshot,
      buttons: [{ id: 'b1', name: 'Next' }, { id: 'b2', name: 'Submit exam' }],
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"submit","note":"RAW_PROVIDER_TEXT"}' } }],
      }));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.stop, undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'ask-user');
  if (result.action?.action !== 'ask-user') return;
  assert.equal(result.action.question, 'I need a safe control on this page. Which of these should I use?');
  assert.deepEqual(result.action.options, ['Next', 'The reservoir answer']);
  assert.equal(JSON.stringify(result).includes('RAW_PROVIDER_TEXT'), false);
  assert.equal(JSON.stringify(result).includes('submit'), false);
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

test('learner stops with an error when every model stays busy', async () => {
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
  assert.equal(result.action, undefined);
  assert.equal(result.stop, true);
  assert.match(result.error || '', /unavailable \(HTTP 503\)/);
  assert.match(result.error || '', /not captured as progress/);
});

test('learner stops when the provider does not respond', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    models: ['gpt-4o-mini'],
    snapshot,
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(result.stop, true);
  assert.equal(result.action, undefined);
  assert.match(result.error || '', /no response/);
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

test('learner sends bounded guidance and an ask-user example', async () => {
  let body = '';
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: { ...snapshot, guidance: `  ${'g'.repeat(2500)}` },
    fetchImpl: async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"ask-user","question":"Which module?"}' } }],
      }));
    },
  });
  const sent = JSON.parse(JSON.parse(body).messages[1].content) as { guidance?: string };
  assert.equal(sent.guidance?.length, 2000);
  assert.match(LEARNER_SYSTEM_PROMPT, /\{"action":"ask-user","question":"Which module should I open\?"/);
  assert.match(LEARNER_SYSTEM_PROMPT, /Never request credentials/);
  assert.match(LEARNER_SYSTEM_PROMPT, /Never infer a pass/);
  assert.deepEqual(result.action, { action: 'ask-user', question: 'Which module?' });
});

test('learner guidance is text of at most 2000 characters', () => {
  assert.deepEqual(learnerGuidanceText(' Open question 2 '), { ok: true, guidance: 'Open question 2' });
  assert.deepEqual(learnerGuidanceText(''), { ok: true });
  assert.deepEqual(learnerGuidanceText(null), { ok: true });
  assert.equal(learnerGuidanceText('x'.repeat(2000)).ok, true);
  assert.equal(learnerGuidanceText('x'.repeat(2001)).ok, false);
  assert.equal(learnerGuidanceText(12).ok, false);
  assert.equal(learnerGuidanceText({ text: 'Open question 2' }).ok, false);
});

test('learner detection must match the selected tab', () => {
  const tab = { targetId: 'tab-1', index: 2, url: 'https://example.test/module' };
  const target = { targetId: 'tab-1', browserSessionId: 'session-1', revision: 4 };
  assert.doesNotThrow(() => assertLearnerDetectionMatch({
    sessionId: 'session-1',
    revision: 4,
    tabs: [tab],
    detection: { detected: 'csod-curriculum', tabIdx: 2, url: tab.url },
    target,
  }));
  assert.throws(() => assertLearnerDetectionMatch({
    sessionId: 'session-1',
    revision: 4,
    tabs: [tab, { targetId: 'tab-2', index: 0, url: 'https://example.test/other' }],
    detection: { detected: 'unknown', tabIdx: 0, url: 'https://example.test/other' },
    target,
  }), /does not match the selected tab/);
  assert.throws(() => assertLearnerDetectionMatch({
    sessionId: 'session-1',
    revision: 4,
    tabs: [tab],
    detection: { detected: 'server-assessment', tabIdx: 2, url: tab.url },
    target,
  }), /Cornerstone navigation page|server|unrecognized/);
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

test('learner asks for help when the model action is not JSON', async () => {
  let calls = 0;
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: { title: 'Empty', buttons: [], choices: [] },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'not json RAW_PROVIDER_TEXT' } }],
      }));
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    action: { action: 'ask-user', question: 'I need a safe next step on this page. What should I do?' },
  });
  assert.equal(JSON.stringify(result).includes('RAW_PROVIDER_TEXT'), false);
});

test('learner asks using current controls when the model target is not on the page', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: {
      buttons: [
        { id: 'b1', name: 'Course interaction: 3_100_click1' },
        { id: 'b2', name: 'Next' },
        { id: 'b3', name: 'Home' },
      ],
    },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"click","targetId":"b9","raw":"RAW_PROVIDER_TEXT"}' } }],
    })),
  });
  assert.deepEqual(result.action, {
    action: 'ask-user',
    question: 'I need a safe control on this page. Which of these should I use?',
    options: ['Next', 'Home', 'Ask me to identify the control'],
  });
  assert.equal(result.stop, undefined);
  assert.equal(JSON.stringify(result).includes('RAW_PROVIDER_TEXT'), false);
});

test('learner still clicks a current navigation control', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"click","targetId":"b1"}' } }],
    })),
  });
  assert.deepEqual(result.action, { action: 'click', targetId: 'b1' });
});

test('learner keeps an auth failure distinct from a help request', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot,
    fetchImpl: async () => new Response('unauthorized', { status: 401 }),
  });
  assert.equal(result.action, undefined);
  assert.equal(result.stop, true);
  assert.match(result.error || '', /failed \(401\)/);
});

test('learner sends the page address without query or hash', async () => {
  let sent = '';
  await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: {
      ...snapshot,
      url: 'https://hpi-external.sabacloud.com/Saba/Web_spf/NA/app/me/ledetail/cours1?token=secret#section',
    },
    fetchImpl: async (_url, init) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"wait","ms":500}' } }],
      }));
    },
  });
  const page = JSON.parse(JSON.parse(sent).messages[1].content) as { url?: string };
  assert.equal(page.url, 'https://hpi-external.sabacloud.com/Saba/Web_spf/NA/app/me/ledetail/cours1');
  assert.equal(sent.includes('token=secret'), false);
});
