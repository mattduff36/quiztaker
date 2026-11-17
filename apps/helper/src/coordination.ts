import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLearnerAction, type LearnerAction, type LearnerSnapshot } from '@quiztaker/core';
import { sanitizeLogValue } from './terminal-ui.js';

interface Connection {
  id: string;
  expiresAt: number;
}

export type LearnerDecision = { action?: unknown; stop?: boolean; error?: string };

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Exchange one time-limited, observation-bound request with the active local Codex chat. */
export async function askCoordinator(
  home: string,
  jobId: string,
  snapshot: LearnerSnapshot,
  reason: string,
  timeoutMs = 70_000,
  cancelled?: () => boolean,
  onRequest?: () => void,
): Promise<LearnerAction | undefined> {
  const directory = join(home, 'coordination');
  const connection = await readJson(join(directory, 'connection.json')) as Connection | null;
  if (typeof connection?.id !== 'string' || !(connection.expiresAt > Date.now())) return;
  const id = randomUUID();
  const request = join(directory, `${id}.request.json`);
  const reply = join(directory, `${id}.reply.json`);
  const temporary = `${request}.tmp`;
  const expiresAt = Math.min(connection.expiresAt, Date.now() + timeoutMs);
  const { title, url, text, buttons, choices, tabs, outlines } = snapshot;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify({
      id, connectionId: connection.id, expiresAt, jobId,
      reason: sanitizeLogValue(reason.slice(0, 500)),
      snapshot: sanitizeLogValue({ title, url, text, buttons, choices, tabs, outlines }),
    }), { flag: 'wx' });
    await rename(temporary, request);
    onRequest?.();
    while (Date.now() < expiresAt && !cancelled?.()) {
      const value = await readJson(reply) as { id?: string; connectionId?: string; action?: unknown } | null;
      if (value?.id === id && value.connectionId === connection.id && Date.now() < expiresAt && !cancelled?.()) {
        const checked = parseLearnerAction(value.action, snapshot, { mode: 'quiz' });
        if (checked.ok) return checked.action;
        await rm(reply, { force: true });
      }
      await delay(350);
    }
  } finally {
    await Promise.allSettled([request, reply, temporary].map(path => rm(path, { force: true })));
  }
}

export async function coordinateDecision(
  decide: (snapshot: unknown) => Promise<LearnerDecision>,
  ask: (snapshot: LearnerSnapshot, reason: string) => Promise<LearnerAction | undefined>,
  snapshot: LearnerSnapshot & { blockedControl?: boolean; coordinationStart?: boolean },
): Promise<LearnerDecision> {
  const { blockedControl, coordinationStart, ...observation } = snapshot;
  if (blockedControl === true) {
    const action = await ask(observation, 'The previous browser click was blocked. Inspect the fresh observation and suggest a different safe next step.');
    return { action: action ?? { action: 'ask-user', question: 'A course control was blocked. Can you open the next page in the helper browser?' } };
  }
  const decision = await decide(observation);
  if (!decision.stop && (coordinationStart === true || (decision.action as { action?: string } | undefined)?.action === 'ask-user')) {
    const question = (decision.action as { question?: string } | undefined)?.question;
    const action = await ask(observation, typeof question === 'string' ? question : 'Review the starting page and propose the next course step.');
    if (action) return { action };
  }
  return decision;
}
