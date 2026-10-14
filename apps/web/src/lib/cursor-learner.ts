import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LearnerAction, LearnerSnapshot } from '@quiztaker/core';
import { LEARNER_SYSTEM_PROMPT } from '@/lib/learner';

const CURSOR_TIMEOUT_MS = 90_000;

export async function askCursorLearner(input: {
  apiKey: string;
  model?: string;
  snapshot: LearnerSnapshot;
}): Promise<{ action?: LearnerAction; stop?: boolean; error?: string }> {
  const sdk = await import('@cursor/sdk');
  const cwd = await mkdtemp(path.join(tmpdir(), 'quiztaker-learner-'));
  let agent: Awaited<ReturnType<typeof sdk.Agent.create>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const model = await cursorModel(sdk, input.apiKey, input.model);
    console.info(`Learner asking Cursor (${model.id})`);
    agent = await sdk.Agent.create({
      apiKey: input.apiKey,
      name: 'quiz-learner',
      model,
      tools: [],
      local: {
        cwd,
        settingSources: [],
        store: new sdk.JsonlLocalAgentStore(cwd),
      },
    });
    const run = await agent.send([
      LEARNER_SYSTEM_PROMPT,
      'Do not use tools, edit files, or run commands.',
      'Reply with one JSON object and no other text.',
      JSON.stringify(input.snapshot),
    ].join('\n'));
    const result = await Promise.race([
      run.wait(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CURSOR_TIMEOUT_MS);
      }),
    ]);
    if (!result) {
      if (run.supports('cancel')) await run.cancel().catch(() => undefined);
      return { stop: true, error: 'Cursor learner timed out' };
    }
    if (result.status !== 'finished') {
      return { stop: true, error: result.error?.message || 'Cursor learner failed' };
    }
    const { decideLearnerStep } = await import('@quiztaker/core');
    const decided = decideLearnerStep(result.result || '', input.snapshot);
    if (!decided.ok) return { stop: true, error: decided.error };
    return { action: decided.action };
  } catch (error) {
    if (error instanceof sdk.CursorAgentError) {
      return { stop: true, error: `Cursor learner did not start: ${error.message}` };
    }
    return { stop: true, error: error instanceof Error ? error.message : 'Cursor learner failed' };
  } finally {
    if (timer) clearTimeout(timer);
    await agent?.[Symbol.asyncDispose]().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

type CursorSdk = typeof import('@cursor/sdk');

let cachedModel: { id: string; params?: Array<{ id: string; value: string }> } | undefined;

async function cursorModel(sdk: CursorSdk, apiKey: string, override?: string) {
  const requested = override?.trim();
  if (requested) return { id: requested };
  if (cachedModel) return cachedModel;
  const models = await sdk.Cursor.models.list({ apiKey });
  const composer = models.find((model) => model.id === 'composer-2.5');
  const fast = composer?.parameters?.find((parameter) => parameter.id === 'fast');
  const fastValue = fast?.values.find((value) => value.value === 'true')?.value;
  cachedModel = composer
    ? { id: composer.id, ...(fast && fastValue ? { params: [{ id: fast.id, value: fastValue }] } : {}) }
    : { id: 'auto' };
  return cachedModel;
}
