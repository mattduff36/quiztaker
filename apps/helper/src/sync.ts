import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAutomationRoot, getHelperHome } from './config.js';

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

function eventFor(
  kind: string,
  title: string,
  result: string,
  detail: string,
  payload: Record<string, unknown>,
): HistorySyncEvent {
  const occurredAt = normalizeDate(payload.ts);
  const sourceId = createHash('sha256')
    .update(JSON.stringify([kind, title, occurredAt, payload.event || '']))
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
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
