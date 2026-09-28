import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobEventInput } from '@quiztaker/core';
import { ensureHelperDirectories, getHelperHome } from './config.js';

export interface OutboxEvent {
  jobId: string;
  event: JobEventInput;
}

export function rememberOutbox(jobId: string, event: JobEventInput): void {
  ensureHelperDirectories();
  appendFileSync(outboxPath(), `${JSON.stringify({ jobId, event })}\n`);
}

export function readOutbox(): OutboxEvent[] {
  return parseFile(outboxPath());
}

export function replaceOutbox(events: OutboxEvent[]): void {
  ensureHelperDirectories();
  writeFileSync(outboxPath(), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
}

export function takeOutboxBatch(): { events: OutboxEvent[]; commit: (failed: OutboxEvent[]) => void } {
  ensureHelperDirectories();
  recoverProcessing();
  try {
    renameSync(outboxPath(), processingPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], commit() { /* nothing was claimed */ } };
    throw error;
  }
  const events = parseFile(processingPath());
  let settled = false;
  return {
    events,
    commit(failed) {
      if (settled) return;
      settled = true;
      if (failed.length) {
        const current = existsSync(outboxPath()) ? readFileSync(outboxPath(), 'utf8') : '';
        writeFileSync(outboxPath(), `${serialize(failed)}${current}`);
      }
      rmSync(processingPath(), { force: true });
    },
  };
}

function outboxPath(): string {
  return join(getHelperHome(), 'event-outbox.jsonl');
}

function processingPath(): string {
  return join(getHelperHome(), 'event-outbox.processing.jsonl');
}

function parseFile(file: string): OutboxEvent[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OutboxEvent);
  } catch {
    return [];
  }
}

function serialize(events: OutboxEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

function recoverProcessing(): void {
  if (!existsSync(processingPath())) return;
  const prior = readFileSync(processingPath(), 'utf8');
  const current = existsSync(outboxPath()) ? readFileSync(outboxPath(), 'utf8') : '';
  const prefix = prior && !prior.endsWith('\n') ? `${prior}\n` : prior;
  writeFileSync(outboxPath(), `${prefix}${current}`);
  rmSync(processingPath(), { force: true });
}
