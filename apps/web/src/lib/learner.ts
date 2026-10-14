import type { LearnerAction, LearnerSnapshot } from '@quiztaker/core';

export const LEARNER_SYSTEM_PROMPT = [
  'You navigate one quiz page for the operator.',
  'Reply with one JSON object and no other text.',
  'Allowed actions are click, answer-select, scroll, wait, capture, and verify.',
  'click and answer-select must use a targetId from the snapshot.',
  'Never choose submit, finish, exit, end test, or grade.',
  'Use verify with passed true only when the page already shows the quiz is passed.',
  'Use verify with passed false when the quiz is still in progress.',
].join(' ');

const GEMINI_FALLBACKS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

export function learnerPrefersCursor(input: {
  nodeEnv?: string;
  vercel?: string;
  cursorApiKey?: string;
}): boolean {
  return Boolean(input.cursorApiKey) && input.vercel !== '1' && input.nodeEnv !== 'production';
}

export function learnerIsEnabled(input: {
  learnerApiKey?: string;
  cursorApiKey?: string;
  nodeEnv?: string;
  vercel?: string;
}): boolean {
  return Boolean(input.learnerApiKey) || learnerPrefersCursor(input);
}

export function learnerModelChain(input: {
  model?: string;
  models?: string;
  baseUrl?: string;
}): string[] {
  const primary = input.model?.trim() || 'gpt-4o-mini';
  const configured = (input.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  const gemini = /generativelanguage\.googleapis\.com/i.test(input.baseUrl || '');
  const extras = configured.length ? configured : (gemini ? GEMINI_FALLBACKS : []);
  return [...new Set([primary, ...extras])].slice(0, GEMINI_FALLBACKS.length + 1);
}

export async function requestLearnerDecision(input: {
  apiKey: string | undefined;
  baseUrl?: string;
  model?: string;
  models?: string[];
  snapshot: LearnerSnapshot;
  fetchImpl?: typeof fetch;
  cursor?: (snapshot: LearnerSnapshot) => Promise<{ action?: LearnerAction; stop?: boolean; error?: string }>;
}): Promise<{ action?: LearnerAction; stop?: boolean; error?: string }> {
  const snapshot = boundSnapshot(input.snapshot);
  if (input.cursor) {
    try {
      const cursor = await input.cursor(snapshot);
      if (cursor.action || cursor.stop) return cursor;
      return { stop: true, error: cursor.error || 'Cursor learner returned nothing' };
    } catch (error) {
      return { stop: true, error: error instanceof Error ? error.message : 'Cursor learner failed' };
    }
  }
  if (!input.apiKey) return { stop: true, error: 'Learner API key is not configured' };
  const base = (input.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const models = input.models?.length ? input.models : [input.model || 'gpt-4o-mini'];
  let last: Response | null = null;
  for (const model of models) {
    const response = await requestModel(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: LEARNER_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(snapshot) },
        ],
      }),
    });
    if (response?.ok) {
      const body = await response.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const content = body?.choices?.[0]?.message?.content ?? '';
      const { decideLearnerStep } = await import('@quiztaker/core');
      const decided = decideLearnerStep(content, snapshot);
      if (!decided.ok) return { stop: true, error: decided.error };
      return { action: decided.action };
    }
    last = response;
    const status = response?.status ?? 0;
    if (response && status !== 404 && status !== 408 && status !== 429 && status < 500) {
      return { stop: true, error: `Learner model request failed (${status})` };
    }
  }
  const status = last?.status ?? 0;
  if (!last || status === 404 || status === 408 || status === 429 || status >= 500) {
    return { action: { action: 'capture' } };
  }
  return { stop: true, error: `Learner model request failed (${status})` };
}

async function requestModel(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
}

function boundSnapshot(snapshot: LearnerSnapshot): LearnerSnapshot {
  return {
    title: snapshot.title?.slice(0, 200) ?? '',
    url: snapshot.url?.slice(0, 500) ?? '',
    text: snapshot.text?.slice(0, 6000) ?? '',
    choices: (snapshot.choices ?? []).slice(0, 40).map(boundControl),
    buttons: (snapshot.buttons ?? []).slice(0, 40).map(boundControl),
  };
}

function boundControl(control: { id: string; name: string }): { id: string; name: string } {
  return {
    id: String(control.id).slice(0, 8),
    name: String(control.name).slice(0, 160),
  };
}
