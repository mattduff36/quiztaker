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

function describeReply(action: LearnerAction, snapshot: LearnerSnapshot): string {
  switch (action.action) {
    case 'click': return `Click ${snapshot.buttons?.find(button => button.id === action.targetId)?.name ?? 'the course control'}.`;
    case 'answer-select': return `Select ${snapshot.choices?.find(choice => choice.id === action.targetId)?.name ?? 'the answer'}.`;
    case 'answer-text': return 'Enter the answer in the observed course response field.';
    case 'select-tab': return 'Switch to the selected course tab.';
    case 'scroll': return `Scroll ${action.direction === 'up' ? 'up' : 'down'}.`;
    case 'find-text': return 'Find the requested text on the page.';
    case 'capture': return 'Capture the current course screen.';
    case 'verify': return 'Check the visible course result.';
    case 'wait': return 'Wait for the page to respond.';
    case 'ask-user': return action.question;
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
  showExchange?: (line: string) => void,
): Promise<LearnerAction | undefined> {
  const directory = join(home, 'coordination');
  const connection = await readJson(join(directory, 'connection.json')) as Connection | null;
  if (typeof connection?.id !== 'string' || !(connection.expiresAt > Date.now())) return;
  const id = randomUUID();
  const request = join(directory, `${id}.request.json`);
  const reply = join(directory, `${id}.reply.json`);
  const temporary = `${request}.tmp`;
  const expiresAt = Math.min(connection.expiresAt, Date.now() + timeoutMs);
  const { title, url, text, buttons, choices, fields, playback, tabs, outlines } = snapshot;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify({
      id, connectionId: connection.id, expiresAt, jobId,
      reason: sanitizeLogValue(reason.slice(0, 500)),
      snapshot: sanitizeLogValue({ title, url, text, buttons, choices, fields, playback, tabs, outlines }),
    }), { flag: 'wx' });
    await rename(temporary, request);
    showExchange?.(`Vitriol → ChatGPT · ${reason}`);
    while (Date.now() < expiresAt && !cancelled?.()) {
      const value = await readJson(reply) as { id?: string; connectionId?: string; action?: unknown } | null;
      if (value?.id === id && value.connectionId === connection.id && Date.now() < expiresAt && !cancelled?.()) {
        const checked = parseLearnerAction(value.action, snapshot, { mode: 'quiz' });
        if (checked.ok) {
          showExchange?.(`ChatGPT → Vitriol · ${describeReply(checked.action, snapshot)}`);
          return checked.action;
        }
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
  snapshot: LearnerSnapshot & { blockedControl?: boolean; screenshotBlocked?: boolean; coordinationStart?: boolean },
): Promise<LearnerDecision> {
  const { blockedControl, screenshotBlocked, coordinationStart, ...observation } = snapshot;
  if (screenshotBlocked === true) {
    const action = await ask(observation, 'Another screenshot would show the unchanged page. Can you identify the next step from the visible course controls?');
    return { action: action ?? { action: 'ask-user', question: 'Another screenshot would show the same page. Can you identify the next course step?' } };
  }
  if (blockedControl === true) {
    const action = await ask(observation, 'The previous course control did not respond as expected. Inspect the fresh observation and suggest a different next step.');
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
