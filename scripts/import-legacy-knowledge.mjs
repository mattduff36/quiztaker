import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const dryRun = process.argv.includes('--dry');
const root = process.cwd();

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function sourceId(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function importedCapabilityVersion(strategy) {
  const version = Number(strategy?.capabilityVersion);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

const history = [
  ...readJsonl(join(root, 'data', 'course-history', 'certifications.jsonl')).map((row) => ({
    sourceId: sourceId(['cert', row.certId || row.title, row.ts || row.completedAt]),
    kind: 'cert',
    title: String(row.title || row.certTitle || row.certId || 'Certification'),
    result: String(row.result || 'acquired'),
    detail: String(row.detail || ''),
    occurredAt: new Date(row.ts || row.completedAt || Date.now()).toISOString(),
    payload: row,
  })),
  ...readJsonl(join(root, 'data', 'course-history', 'log.jsonl')).map((row) => ({
    sourceId: sourceId(['course', row.label, row.ts]),
    kind: 'course',
    title: String(row.label || 'Course'),
    result: String(row.result?.after || row.status_set || 'unknown'),
    detail: String(row.strategy || ''),
    occurredAt: new Date(row.ts || Date.now()).toISOString(),
    payload: row,
  })),
  ...readJsonl(join(root, 'data', 'course-history', 'batch.jsonl'))
    .filter((row) => row.event === 'verify' && row.course)
    .map((row) => ({
      sourceId: sourceId(['batch', row.course, row.ts]),
      kind: 'course',
      title: String(row.course),
      result: row.ok ? 'passed' : String(row.status || 'needs review'),
      detail: String(row.how || ''),
      occurredAt: new Date(row.ts || Date.now()).toISOString(),
      payload: row,
    })),
  ...readJsonl(join(root, 'data', 'course-history', 'container.jsonl'))
    .filter((row) => row.event === 'verify' && row.title)
    .map((row) => ({
      sourceId: sourceId(['activity', row.title, row.ts]),
      kind: 'activity',
      title: String(row.title),
      result: row.ok ? 'passed' : String(row.status || 'needs review'),
      detail: String(row.result?.err || ''),
      occurredAt: new Date(row.ts || Date.now()).toISOString(),
      payload: row,
    })),
  ...readJsonl(join(root, 'data', 'attempts', 'events.jsonl'))
    .filter((row) => row.event === 'attempt-finished')
    .map((row) => ({
      sourceId: sourceId(['attempt', row.attemptId, row.ts]),
      kind: 'attempt',
      title: String(row.capabilityId || 'Automation attempt'),
      result: row.verified ? `${row.outcome || 'finished'} (verified)` : String(row.outcome || 'unknown'),
      detail: String(row.failureSignature || row.status || ''),
      occurredAt: new Date(row.ts || Date.now()).toISOString(),
      payload: row,
    })),
  ...readJsonl(join(root, 'data', 'sessions', 'history.jsonl')).map((row) => ({
    sourceId: sourceId(['session', row.title, row.ts]),
    kind: 'session',
    title: String(row.title || 'Session summary'),
    result: String(row.result || ''),
    detail: String(row.notes || ''),
    occurredAt: new Date(row.ts || Date.now()).toISOString(),
    payload: row,
  })),
];
const reviews = readJsonl(join(root, 'data', 'knowledge', 'review-queue.jsonl'))
  .filter((row) => row.status !== 'resolved' && row.title);
const strategies = existsSync(join(root, 'data', 'knowledge', 'strategies.json'))
  ? JSON.parse(readFileSync(join(root, 'data', 'knowledge', 'strategies.json'), 'utf8')).strategies || {}
  : {};
const captures = readJsonl(join(root, 'data', 'learn', 'index.jsonl'));

if (dryRun) {
  console.log(JSON.stringify({
    history: history.length,
    reviews: reviews.length,
    strategies: Object.keys(strategies).length,
    capabilityVersions: [...new Set(Object.values(strategies).map((strategy) => importedCapabilityVersion(strategy)))].sort((left, right) => left - right),
    captures: captures.length,
  }));
  process.exit(0);
}

const userId = process.env.IMPORT_USER_ID;
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!userId || !connectionString) {
  throw new Error('IMPORT_USER_ID and DATABASE_URL are required unless --dry is set.');
}
const sql = postgres(connectionString, { max: 1, ssl: 'require' });
try {
  if (history.length) {
    await sql`
      insert into history_events (user_id, source_id, kind, title, result, detail, occurred_at, payload)
      select ${userId}, item.source_id, item.kind, item.title, item.result, item.detail, item.occurred_at, item.payload
      from jsonb_to_recordset(${sql.json(history.map((item) => ({
        source_id: item.sourceId,
        kind: item.kind,
        title: item.title,
        result: item.result,
        detail: item.detail,
        occurred_at: item.occurredAt,
        payload: item.payload,
      })))}) as item(source_id text, kind text, title text, result text, detail text, occurred_at timestamptz, payload jsonb)
      on conflict (user_id, helper_id, source_id) do nothing
    `;
  }
  for (const strategy of Object.values(strategies)) {
    await sql`
      insert into strategies (
        user_id, capability_id, capability_version, fingerprint, status, successes, failures, targets, actions, revision
      ) values (
        ${userId},
        ${String(strategy.capabilityId || 'unknown')},
        ${importedCapabilityVersion(strategy)},
        ${strategy.fingerprint || null},
        ${['candidate', 'promoted', 'needs-review'].includes(strategy.status) ? strategy.status : 'candidate'},
        ${Number(strategy.successes || 0)},
        ${Number(strategy.failures || 0)},
        ${sql.json(strategy.targets || [])},
        ${sql.json(strategy.actions || [])},
        1
      )
      on conflict (user_id, capability_id, capability_version, fingerprint) do nothing
    `;
  }
  for (const review of reviews) {
    const existing = await sql`
      select id from review_items
      where user_id = ${userId} and status = 'open' and title = ${String(review.title)}
      limit 1
    `;
    if (existing.length) continue;
    await sql`
      insert into review_items (user_id, type, title, detail, next_action)
      values (
        ${userId},
        ${String(review.type || 'review')},
        ${String(review.title)},
        ${String(review.detail || '')},
        ${String(review.nextAction || review.next_action || '')}
      )
    `;
  }
  for (const capture of captures) {
    const id = String(capture.id || capture.path || capture.fingerprint || capture.ts || '');
    if (!id) continue;
    await sql`
      insert into learning_captures (user_id, source_id, fingerprint, title, detail, probe, captured_at)
      values (
        ${userId},
        ${id},
        ${capture.fingerprint || null},
        ${String(capture.title || capture.label || 'Learning capture')},
        ${String(capture.detail || '')},
        ${sql.json(capture)},
        ${new Date(capture.ts || capture.capturedAt || Date.now()).toISOString()}
      )
      on conflict (user_id, source_id) do nothing
    `;
  }
  console.log(JSON.stringify({ imported: true, history: history.length, reviews: reviews.length, strategies: Object.keys(strategies).length, captures: captures.length }));
} finally {
  await sql.end();
}
