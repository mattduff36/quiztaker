import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAutomationRoot, getHelperHome } from './config.js';
import { HISTORY_SYNC_LIMITS } from '@quiztaker/core';

export interface LocalSyncPayload {
  history: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  captures: Array<Record<string, unknown>>;
}

export function localSyncBatches(payload: LocalSyncPayload): LocalSyncPayload[] {
  const streams = {
    history: uniqueSources(payload.history),
    reviews: uniqueSources(payload.reviews),
    captures: uniqueSources(payload.captures),
  };
  const count = Math.max(...Object.keys(HISTORY_SYNC_LIMITS).map(key => {
    const stream = key as keyof LocalSyncPayload;
    return Math.ceil(streams[stream].length / HISTORY_SYNC_LIMITS[stream]);
  }));
  return Array.from({ length: count }, (_, index) => ({
    history: streams.history.slice(index * HISTORY_SYNC_LIMITS.history, (index + 1) * HISTORY_SYNC_LIMITS.history),
    reviews: streams.reviews.slice(index * HISTORY_SYNC_LIMITS.reviews, (index + 1) * HISTORY_SYNC_LIMITS.reviews),
    captures: streams.captures.slice(index * HISTORY_SYNC_LIMITS.captures, (index + 1) * HISTORY_SYNC_LIMITS.captures),
  }));
}

// Only acknowledged batches advance. A process restart safely replays the local
// ledger against the server's idempotent inserts; no history is removed.
export class LocalHistorySync {
  private pending: LocalSyncPayload[] | null = null;
  private nextAt = 0;
  private failures = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly send: (payload: LocalSyncPayload) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly read: () => LocalSyncPayload = () => ({
      history: readLocalHistory(), reviews: readLocalReviews(), captures: readLocalCaptures(),
    }),
    private readonly now: () => number = Date.now,
  ) {}

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.nextAt) return Promise.resolve();
    this.inFlight = this.syncNext().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async syncNext(): Promise<void> {
    try {
      this.pending ??= localSyncBatches(this.read());
      const batch = this.pending[0];
      if (batch) {
        await this.send(batch);
        this.pending.shift();
      }
      this.failures = 0;
      if (!this.pending.length) {
        this.pending = null;
        this.nextAt = this.now() + 5 * 60_000;
      } else this.nextAt = 0;
    } catch (error) {
      this.nextAt = this.now() + Math.min(5 * 60_000, 30_000 * 2 ** Math.min(this.failures++, 4));
      this.report(error);
    }
  }
}

function uniqueSources(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...new Map(rows.map(row => [String(row.sourceId), row])).values()];
}

interface HistorySyncEvent extends Record<string, unknown> {
  sourceId: string;
  kind: string;
  title: string;
  result: string;
  detail: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export function readLocalHistory(): HistorySyncEvent[] {
  const directories = [
    join(getHelperHome(), 'data', 'course-history'),
    join(getAutomationRoot(), 'data', 'course-history'),
  ];
  const values: HistorySyncEvent[] = [];
  for (const directory of [...new Set(directories)]) {
    values.push(...readJsonl(join(directory, 'certifications.jsonl')).map((row) => eventFor(
      'cert',
      String(row.cert || row.certId || 'Certification'),
      String(row.result || row.score || ''),
      [row.strategy, row.notes].filter(Boolean).join(' — '),
      row,
    )));
    values.push(...readJsonl(join(directory, 'batch.jsonl'))
      .filter((row) => row.event === 'verify' && row.course)
      .map((row) => eventFor(
        'course',
        String(row.course),
        row.ok ? 'passed' : String(row.status || 'needs review'),
        row.how ? `via ${row.how}` : '',
        row,
      )));
    values.push(...readJsonl(join(directory, 'container.jsonl'))
      .filter((row) => row.event === 'verify' && row.title)
      .map((row) => eventFor(
        'activity',
        String(row.title),
        row.ok ? 'passed' : String(row.status || 'needs review'),
        '',
        row,
      )));
    values.push(...readJsonl(join(directory, 'log.jsonl'))
      .filter((row) => row.label)
      .map((row) => eventFor(
        'course',
        String(row.label),
        String((row.result as Record<string, unknown> | undefined)?.after || row.status_set || 'unknown'),
        String(row.strategy || ''),
        row,
      )));
  }
  return [...new Map(values.map((value) => [value.sourceId, value])).values()];
}

export function readLocalReviews(): Array<Record<string, unknown>> {
  const files = [
    join(getHelperHome(), 'data', 'knowledge', 'review-queue.jsonl'),
    join(getAutomationRoot(), 'data', 'knowledge', 'review-queue.jsonl'),
  ];
  return files.flatMap((file) => readJsonl(file))
    .filter((row) => row.status !== 'resolved' && row.title)
    .map((row) => ({
      sourceId: String(row.id || createHash('sha256').update(JSON.stringify(row)).digest('hex')),
      type: String(row.type || 'review'),
      title: String(row.title),
      detail: String(row.detail || row.summary || ''),
      nextAction: String(row.nextAction || row.next_action || row.recommendation || ''),
    }));
}

export function readLocalCaptures(): Array<Record<string, unknown>> {
  const indexFiles = [
    join(getHelperHome(), 'data', 'learn', 'index.jsonl'),
    join(getAutomationRoot(), 'data', 'learn', 'index.jsonl'),
  ];
  return indexFiles.flatMap((file) => readJsonl(file)).map((row) => ({
    sourceId: String(row.id || row.path || row.ts || row.fingerprint || createHash('sha256').update(JSON.stringify(row)).digest('hex')),
    fingerprint: row.fingerprint ? String(row.fingerprint) : null,
    title: String(row.title || row.label || 'Learning capture'),
    detail: String(row.detail || ''),
    capturedAt: normalizeDate(row.ts || row.capturedAt),
    probe: row,
  }));
}

function eventFor(
  kind: string,
  title: string,
  result: string,
  detail: string,
  payload: Record<string, unknown>,
): HistorySyncEvent {
  const occurredAt = normalizeDate(payload.ts);
  const sourceId = createHash('sha256')
    .update(JSON.stringify(occurredAt === new Date(0).toISOString()
      ? [kind,title,payload] : [kind, title, occurredAt, payload.event || '']))
    .digest('hex');
  return { sourceId, kind, title, result, detail, occurredAt, payload };
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function normalizeDate(value: unknown): string {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
