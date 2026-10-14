import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { LearnerAction, LearnerSnapshot } from '@quiztaker/core';
import { queryOne } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import { LEARNER_SYSTEM_PROMPT, learnerIsEnabled } from '@/lib/learner';

export const LLM_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    setupUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    setupUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    setupUrl: 'https://openrouter.ai/settings/keys',
  },
} as const;

export const LLM_PROVIDER_OPTIONS = (Object.keys(LLM_PROVIDERS) as LlmProviderId[]).map((id) => ({
  id,
  label: LLM_PROVIDERS[id].label,
  setupUrl: LLM_PROVIDERS[id].setupUrl,
}));

export type LlmProviderId = keyof typeof LLM_PROVIDERS;
export type LlmSource = 'personal' | 'inherited' | 'disabled' | 'none';

export const LLM_RESPONSE_MAX_BYTES = 64 * 1024;
export const LLM_REQUEST_TIMEOUT_MS = 15_000;
export const LLM_MAX_TOKENS = 256;
export const LLM_SETTINGS_MAX_BYTES = 8 * 1024;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const ALLOWED_ORIGINS = new Set([
  'https://api.openai.com',
  'https://generativelanguage.googleapis.com',
  'https://openrouter.ai',
]);

export const CONNECTION_TEST_SNAPSHOT: LearnerSnapshot = {
  title: 'Connection test',
  url: 'https://example.invalid/llm-connection-test',
  text: 'Synthetic connection test.',
  buttons: [{ id: 'b1', name: 'Next' }],
  choices: [{ id: 'c1', name: 'Sample' }],
};

export type PublicLlmConnection = {
  source: LlmSource;
  ready: boolean;
  provider: LlmProviderId | null;
  model: string | null;
  hasKey: boolean;
  testedAt?: string | null;
};

export type DeploymentLearner = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  cursorApiKey?: string;
  nodeEnv?: string;
  vercel?: string;
};

type PublicRow = {
  provider: string;
  model: string;
  hasKey: boolean;
  testedAt: string | null;
};

export type StoredLlmSecret = {
  provider: string;
  model: string;
  ciphertext: string | null;
  iv: string | null;
  authTag: string | null;
  testedAt: string | null;
};

export type ProposalChoice =
  | { kind: 'inherited' }
  | { kind: 'disabled' }
  | { kind: 'blocked' }
  | { kind: 'personal'; provider: LlmProviderId; model: string; ciphertext: string; iv: string; authTag: string };

export type EncryptedLlmKey = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

type SaveRecord = EncryptedLlmKey & {
  provider: LlmProviderId;
  model: string;
};

export function exceedsByteLimit(length: number, max = LLM_SETTINGS_MAX_BYTES): boolean {
  return !Number.isFinite(length) || length < 0 || length > max;
}

export function llmCredentialKey(encoded: string | undefined): Buffer {
  const trimmed = encoded?.trim() ?? '';
  if (!trimmed) throw new Error('LLM credential key is not configured');
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed)) throw new Error('LLM credential key is invalid');
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32 || key.toString('base64') !== trimmed) {
    throw new Error('LLM credential key is invalid');
  }
  return key;
}

export function hostedChatUrl(provider: string): string {
  if (!isProvider(provider)) throw new Error('Provider is not available');
  return LLM_PROVIDERS[provider].chatUrl;
}

export function providerForBaseUrl(baseUrl: string | undefined): LlmProviderId | null {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  const match = (Object.keys(LLM_PROVIDERS) as LlmProviderId[])
    .find((id) => LLM_PROVIDERS[id].baseUrl === normalized);
  return match ?? null;
}

export function encryptLlmKey(userId: string, plaintext: string, key: Buffer, provider = ''): EncryptedLlmKey {
  assertUserId(userId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([userId, provider, 1]), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptLlmKey(userId: string, packed: EncryptedLlmKey, key: Buffer, provider = ''): string {
  assertUserId(userId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packed.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify([userId, provider, 1]), 'utf8'));
    decipher.setAuthTag(Buffer.from(packed.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(packed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    if (!plaintext) throw new Error('empty');
    return plaintext;
  } catch {
    throw new Error('Credential could not be decrypted');
  }
}

export function sanitizeLlmConnection(row: PublicRow | null, deployment: DeploymentLearner): PublicLlmConnection {
  if (row?.provider === 'disabled') {
    return { source: 'disabled', ready: false, provider: null, model: null, hasKey: false };
  }
  if (row) {
    const provider = isProvider(row.provider) ? row.provider : null;
    const model = normalizeModel(row.model);
    const ready = Boolean(provider && model && row.hasKey && row.testedAt);
    return {
      source: 'personal',
      ready,
      provider,
      model,
      hasKey: row.hasKey === true,
      testedAt: row.testedAt,
    };
  }
  const ready = learnerIsEnabled({
    learnerApiKey: deployment.apiKey,
    cursorApiKey: deployment.cursorApiKey,
    nodeEnv: deployment.nodeEnv,
    vercel: deployment.vercel,
  });
  if (!ready) return { source: 'none', ready: false, provider: null, model: null, hasKey: false };
  return {
    source: 'inherited',
    ready: true,
    provider: providerForBaseUrl(deployment.baseUrl),
    model: normalizeModel(deployment.model || ''),
    hasKey: false,
  };
}

export function chooseProposalLearner(row: StoredLlmSecret | null): ProposalChoice {
  if (!row) return { kind: 'inherited' };
  if (row.provider === 'disabled') return { kind: 'disabled' };
  const model = normalizeModel(row.model);
  if (isProvider(row.provider) && model && row.ciphertext && row.iv && row.authTag && row.testedAt) {
    return {
      kind: 'personal',
      provider: row.provider,
      model,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
    };
  }
  return { kind: 'blocked' };
}

export function resolvePlaintextKey(input: {
  userId: string;
  provider: LlmProviderId;
  apiKey: string;
  stored: StoredLlmSecret | null;
  credentialKey: Buffer;
}): { ok: true; apiKey: string } | { ok: false; error: string } {
  const typed = normalizeApiKey(input.apiKey);
  if (typed) return { ok: true, apiKey: typed };
  if (input.apiKey.trim()) return { ok: false, error: 'API key is invalid' };
  if (!input.stored || input.stored.provider !== input.provider || !input.stored.ciphertext || !input.stored.iv || !input.stored.authTag) {
    return { ok: false, error: 'API key is required' };
  }
  try {
    const apiKey = decryptLlmKey(input.userId, {
      ciphertext: input.stored.ciphertext,
      iv: input.stored.iv,
      authTag: input.stored.authTag,
    }, input.credentialKey, input.provider);
    return normalizeApiKey(apiKey) ? { ok: true, apiKey } : { ok: false, error: 'API key is required' };
  } catch {
    return { ok: false, error: 'Saved API key could not be read' };
  }
}

export async function prepareConnectionSave(input: {
  userId: string;
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  stored: StoredLlmSecret | null;
  credentialKey: Buffer;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; record: SaveRecord } | { ok: false; error: string }> {
  const model = normalizeModel(input.model);
  if (!model) return { ok: false, error: 'Model is invalid' };
  const resolved = resolvePlaintextKey(input);
  if (!resolved.ok) return resolved;
  const tested = await completeHostedChat({
    provider: input.provider,
    model,
    apiKey: resolved.apiKey,
    snapshot: CONNECTION_TEST_SNAPSHOT,
    fetchImpl: input.fetchImpl,
  });
  if (!tested.ok) return tested;
  return {
    ok: true,
    record: {
      provider: input.provider,
      model,
      ...encryptLlmKey(input.userId, resolved.apiKey, input.credentialKey, input.provider),
    },
  };
}

export async function completeHostedChat(input: {
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  snapshot: LearnerSnapshot;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; action: LearnerAction } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(hostedChatUrl(input.provider));
  } catch {
    return { ok: false, error: 'Provider is not available' };
  }
  if (url.protocol !== 'https:' || !ALLOWED_ORIGINS.has(url.origin) || url.username || url.password || url.search) {
    return { ok: false, error: 'Provider is not available' };
  }
  const model = normalizeModel(input.model);
  const apiKey = normalizeApiKey(input.apiKey);
  if (!model || !apiKey) return { ok: false, error: 'Provider request is invalid' };
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          { role: 'system', content: LEARNER_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(input.snapshot) },
        ],
      }),
    });
  } catch {
    return { ok: false, error: 'Provider request did not complete' };
  }
  if (!response.ok) return { ok: false, error: providerFailure(response.status) };
  const body = await readLimited(response);
  if (body == null) return { ok: false, error: 'Provider response was too large' };
  let content = '';
  try {
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const raw = parsed.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return { ok: false, error: 'Provider response was not a learner action' };
    content = raw;
  } catch {
    return { ok: false, error: 'Provider response was not a learner action' };
  }
  const { decideLearnerStep } = await import('@quiztaker/core');
  const decided = decideLearnerStep(content, input.snapshot);
  if (!decided.ok) return { ok: false, error: 'Provider response was not a learner action' };
  return { ok: true, action: decided.action };
}

export async function readPublicLlmConnection(userId: string): Promise<PublicLlmConnection> {
  const row = await queryOne<{
    provider: string;
    model: string;
    has_key: boolean;
    tested_at: string | Date | null;
  }>(
    `select provider, model, (ciphertext is not null) as has_key, tested_at
     from llm_connections
     where user_id = $1`,
    [userId],
  );
  const status = sanitizeLlmConnection(row ? {
    provider: row.provider,
    model: row.model,
    hasKey: row.has_key === true,
    testedAt: row.tested_at ? new Date(row.tested_at).toISOString() : null,
  } : null, currentDeployment());
  if (status.source === 'personal') {
    try { llmCredentialKey(process.env.LLM_CREDENTIAL_KEY); } catch { status.ready = false; }
  }
  return status;
}

export async function loadSecretLlmConnection(userId: string): Promise<StoredLlmSecret | null> {
  const row = await queryOne<{
    provider: string;
    model: string;
    ciphertext: string | null;
    iv: string | null;
    auth_tag: string | null;
    tested_at: string | Date | null;
  }>(
    `select provider, model, ciphertext, iv, auth_tag, tested_at
     from llm_connections
     where user_id = $1`,
    [userId],
  );
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    testedAt: row.tested_at ? new Date(row.tested_at).toISOString() : null,
  };
}

export function currentDeployment(): DeploymentLearner {
  const env = getServerEnv();
  return {
    apiKey: env.LEARNER_API_KEY,
    baseUrl: env.LEARNER_BASE_URL,
    model: env.LEARNER_MODEL,
    cursorApiKey: env.CURSOR_API_KEY,
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
  };
}

function providerFailure(status: number): string {
  if (status === 401 || status === 403) return 'Provider rejected the API key';
  if (status === 404) return 'Provider model was not found';
  if (status === 429) return 'Provider is rate limiting requests';
  return 'Provider request failed';
}

async function readLimited(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > LLM_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > LLM_RESPONSE_MAX_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > LLM_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

function normalizeModel(model: string): string | null {
  const value = model.trim();
  return MODEL_PATTERN.test(value) ? value : null;
}

function normalizeApiKey(apiKey: string): string | null {
  const value = apiKey.trim();
  if (value.length < 16 || value.length > 512) return null;
  if (/[\s\u0000-\u001f]/.test(value)) return null;
  return value;
}

function assertUserId(userId: string) {
  if (!userId || userId.length > 200) throw new Error('Credential owner is invalid');
}

function isProvider(value: string): value is LlmProviderId {
  return Object.prototype.hasOwnProperty.call(LLM_PROVIDERS, value);
}

export async function readSettingsBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LLM_SETTINGS_MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
