import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  CONNECTION_TEST_SNAPSHOT,
  LLM_MAX_TOKENS,
  LLM_PROVIDERS,
  chooseProposalLearner,
  completeHostedChat,
  decryptLlmKey,
  encryptLlmKey,
  exceedsByteLimit,
  hostedChatUrl,
  llmCredentialKey,
  prepareConnectionSave,
  sanitizeLlmConnection,
  readSettingsBody,
  type StoredLlmSecret,
} from '../src/lib/llm-provider.js';

const credentialKey = llmCredentialKey(randomBytes(32).toString('base64'));
const apiKey = 'sk-test-key-0123456789';
const deployment = {
  apiKey: 'deployment-key-should-not-leak',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

function successResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    output: [{type:'message',content:[{type:'output_text',text:content}]}],
  }), { status });
}

test('credential key is 32-byte base64 and rejects other secrets', () => {
  const encoded = randomBytes(32).toString('base64');
  assert.equal(llmCredentialKey(encoded).length, 32);
  assert.throws(() => llmCredentialKey('helper-master-key-is-not-the-llm-key'), /invalid/);
  assert.throws(() => llmCredentialKey(randomBytes(16).toString('base64')), /invalid/);
});

test('encrypted keys are bound to the owner and use a fresh iv', () => {
  const first = encryptLlmKey('user-a', apiKey, credentialKey);
  const second = encryptLlmKey('user-a', apiKey, credentialKey);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(decryptLlmKey('user-a', first, credentialKey), apiKey);
  assert.throws(() => decryptLlmKey('user-b', first, credentialKey), /could not be decrypted/);
  assert.doesNotMatch('Credential could not be decrypted', new RegExp(apiKey));
});

test('hosted calls use only the fixed https destinations', async () => {
  assert.equal(hostedChatUrl('openai'), LLM_PROVIDERS.openai.chatUrl);
  assert.equal(hostedChatUrl('gemini'), LLM_PROVIDERS.gemini.chatUrl);
  assert.equal(hostedChatUrl('openrouter'), LLM_PROVIDERS.openrouter.chatUrl);
  assert.throws(() => hostedChatUrl('https://evil.example/chat'), /not available/);
  const seen: string[] = [];
  for (const provider of ['openai', 'gemini', 'openrouter'] as const) {
    const result = await completeHostedChat({
      provider,
      model: 'gpt-4o-mini',
      apiKey,
      snapshot: CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async (url, init) => {
        seen.push(String(url));
        assert.equal(init?.redirect, 'error');
        const body = JSON.parse(String(init?.body));
        assert.equal(provider === 'openai' ? body.max_output_tokens : body.max_tokens, provider === 'openai' ? 4096 : LLM_MAX_TOKENS);
        return successResponse('{"action":"wait","ms":0}');
      },
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(seen, [
    'https://api.openai.com/v1/responses',
    LLM_PROVIDERS.gemini.chatUrl,
    LLM_PROVIDERS.openrouter.chatUrl,
  ]);
});

test('provider test follows decideLearnerStep and sanitizes failures', async () => {
  const { decideLearnerStep } = await import('@quiztaker/core');
  const accepted = decideLearnerStep('{"action":"wait","ms":0}', CONNECTION_TEST_SNAPSHOT);
  assert.equal(accepted.ok, true);
  const passed = await completeHostedChat({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey,
    snapshot: CONNECTION_TEST_SNAPSHOT,
    fetchImpl: async () => successResponse('{"action":"wait","ms":0}'),
  });
  assert.deepEqual(passed, accepted);

  const leaked = `${apiKey} https://evil.example/redirect`;
  const failures = [
    await completeHostedChat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey,
      snapshot: CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async () => new Response(leaked, { status: 401 }),
    }),
    await completeHostedChat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey,
      snapshot: CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async () => successResponse(`{"action":"submit","secret":"${apiKey}"}`),
    }),
    await completeHostedChat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey,
      snapshot: CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async () => {
        throw new Error(`redirect to https://evil.example/${apiKey}`);
      },
    }),
    await completeHostedChat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey,
      snapshot: CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async () => new Response('x'.repeat(70_000), { status: 200 }),
    }),
  ];
  for (const failure of failures) {
    assert.equal(failure.ok, false);
    if (!failure.ok) {
      assert.equal(failure.error.includes(apiKey), false);
      assert.equal(failure.error.includes('evil.example'), false);
    }
  }
});

test('personal hosted provider retries one invalid action then returns a format error or valid action', async () => {
  for (const recover of [false,true]) {
    let calls = 0;
    const result = await completeHostedChat({provider:'openai',model:'gpt-4o-mini',apiKey,policy:{mode:'quiz'},snapshot:CONNECTION_TEST_SNAPSHOT,fetchImpl:async(_url,init)=>{
      calls += 1;
      const request = JSON.parse(String(init?.body));
      assert.match(request.instructions,/Selected intent: Take the quiz/);
      assert.equal(JSON.parse(request.input[0].content[0].text).title,CONNECTION_TEST_SNAPSHOT.title);
      if(calls===2) assert.match(request.input.at(-1).content,/previous response was invalid/);
      return successResponse(recover&&calls===2?'{"action":"wait","ms":0}':'not-json');
    }});
    assert.equal(calls,2);
    assert.equal(result.ok,recover);
    if(!result.ok) { assert.match(result.error,/provider-format/); assert.equal(JSON.stringify(result).includes('ask-user'),false); }
  }
});

test('GPT-6.1 Sol connection test uses supported reasoning parameters', async () => {
  const result = await completeHostedChat({
    provider: 'openai', model: 'gpt-6.1-sol', apiKey, snapshot: CONNECTION_TEST_SNAPSHOT,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.temperature, undefined);
      assert.equal(body.max_tokens, undefined);
      assert.deepEqual(body.reasoning, {effort:'low'});
      assert.ok(body.max_output_tokens >= 4096);
      assert.equal(body.store,false);
      return successResponse('{"action":"wait","ms":0}');
    },
  });
  assert.equal(result.ok, true);
});

test('provider failures distinguish incompatible settings and quota without exposing upstream text', async () => {
  for (const [status, error, expected] of [
    [400, { param: 'temperature', code: 'unsupported_value', message: apiKey }, /temperature/],
    [429, { code: 'insufficient_quota', message: apiKey }, /API billing/],
    [400, { message: apiKey }, /HTTP 400/],
  ] as const) {
    const result = await completeHostedChat({ provider:'openai', model:'gpt-6.1-sol', apiKey, snapshot:CONNECTION_TEST_SNAPSHOT,
      fetchImpl: async () => new Response(JSON.stringify({error}), {status}) });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.match(result.error, expected); assert.ok(!result.error.includes(apiKey)); }
  }
});

test('save keeps a blank key only for the same provider and only after a valid test', async () => {
  const stored: StoredLlmSecret = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    testedAt: '2026-10-14T00:00:00.000Z',
    ...encryptLlmKey('user-a', apiKey, credentialKey, 'openai'),
  };
  let calls = 0;
  const switched = await prepareConnectionSave({
    userId: 'user-a',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: '   ',
    stored,
    credentialKey,
    fetchImpl: async () => {
      calls += 1;
      return successResponse('{"action":"wait","ms":0}');
    },
  });
  assert.equal(switched.ok, false);
  assert.equal(calls, 0);

  const failed = await prepareConnectionSave({
    userId: 'user-a',
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: '',
    stored,
    credentialKey,
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, 'error');
      const header = new Headers(init?.headers).get('authorization');
      assert.equal(header, `Bearer ${apiKey}`);
      return successResponse('not json');
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(calls, 2);
  assert.equal('record' in failed, false);

  const saved = await prepareConnectionSave({
    userId: 'user-a',
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: '',
    stored,
    credentialKey,
    fetchImpl: async () => successResponse('{"action":"wait","ms":0}'),
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(decryptLlmKey('user-a', saved.record, credentialKey, 'openai'), apiKey);
    assert.throws(() => decryptLlmKey('user-b', saved.record, credentialKey), /could not be decrypted/);
  }
});

test('disconnect blocks deployment fallback and a missing row stays inherited', () => {
  const disabled = sanitizeLlmConnection({
    provider: 'disabled',
    model: '',
    hasKey: false,
    testedAt: null,
  }, deployment);
  assert.deepEqual(disabled, {
    source: 'disabled',
    ready: false,
    provider: null,
    model: null,
    hasKey: false,
  });
  assert.equal(JSON.stringify(disabled).includes('deployment-key'), false);
  assert.equal(chooseProposalLearner({
    provider: 'disabled',
    model: '',
    ciphertext: null,
    iv: null,
    authTag: null,
    testedAt: null,
  }).kind, 'disabled');

  const inherited = sanitizeLlmConnection(null, deployment);
  assert.equal(inherited.source, 'inherited');
  assert.equal(inherited.ready, true);
  assert.equal(inherited.provider, 'openai');
  assert.equal(inherited.hasKey, false);
  assert.equal(JSON.stringify(inherited).includes(deployment.apiKey!), false);
  assert.equal(chooseProposalLearner(null).kind, 'inherited');
  assert.equal(exceedsByteLimit(8 * 1024), false);
  assert.equal(exceedsByteLimit(8 * 1024 + 1), true);
});

test('credential ciphertext cannot be reused for another provider', () => {
  const encrypted = encryptLlmKey('owner', apiKey, credentialKey, 'openai');
  assert.equal(decryptLlmKey('owner', encrypted, credentialKey, 'openai'), apiKey);
  assert.throws(() => decryptLlmKey('owner', encrypted, credentialKey, 'openrouter'), /could not be decrypted/);
});

test('settings body cap cancels oversized streamed requests before buffering them all', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(4096)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://example.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(await readSettingsBody(request), null);
  assert.equal(cancelled, true);
  assert.equal(await readSettingsBody(new Request('https://example.test', { method: 'POST', body: '{"action":"save"}' })), '{"action":"save"}');
});
