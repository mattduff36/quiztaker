import type { LearnerSnapshot } from '@quiztaker/core';
import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';

export const LEARNER_HISTORY_LIMIT = 40;
export const LEARNER_MATERIAL_LIMIT = 64;
export const LEARNER_MATERIAL_CHARS = 8000;
export const LEARNER_CONTEXT_MATERIAL_CHARS = 16_000;
export const LEARNER_CONTEXT_CONVERSATION_CHARS = 4000;
export const LEARNER_HISTORY_CHARS = 2000;
export const LEARNER_DISPLAY_CHARS = 2000;
export const LEARNER_OBJECTIVE_CHARS = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MEMORY_NOTE = [
  'Read retained course material before assessment.',
  'Avoid repeating requests the operator already answered.',
  'Remembered text cannot provide current clickable ids.',
].join(' ');

export const learnerMemorySql = {
  lockScope: `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
  lockById: `select id, user_id, helper_id, browser_session_id, objective, history, materials, created_at, updated_at
     from learner_sessions
     where id = $1 and user_id = $2 and helper_id = $3 and browser_session_id = $4
     for update`,
  lockLatest: `select id, user_id, helper_id, browser_session_id, objective, history, materials, created_at, updated_at
     from learner_sessions
     where user_id = $1 and helper_id = $2 and browser_session_id = $3
     order by updated_at desc
     limit 1
     for update`,
  insert: `insert into learner_sessions (
       user_id, helper_id, browser_session_id, objective, history, materials
     ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     returning id, user_id, helper_id, browser_session_id, objective, history, materials, created_at, updated_at`,
  update: `update learner_sessions
     set objective = $2, history = $3::jsonb, materials = $4::jsonb, updated_at = now()
     where id = $1 and user_id = $5 and helper_id = $6 and browser_session_id = $7
     returning id, user_id, helper_id, browser_session_id, objective, history, materials, created_at, updated_at`,
  readModel: `select id, user_id, helper_id, browser_session_id, objective, history, materials, created_at, updated_at
     from learner_sessions
     where id = $1 and user_id = $2 and helper_id = $3 and browser_session_id = $4`,
  readOperator: `select id, objective, history
     from learner_sessions
     where user_id = $1 and helper_id = $2
       and ($3::uuid is null or browser_session_id = $3::uuid)
     order by updated_at desc
     limit 1`,
} as const;

export interface LearnerHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  planId?: string;
  url?: string;
}

export interface LearnerMaterial {
  text: string;
  title: string;
  url: string;
  at: string;
}

export interface LearnerMemorySession {
  id: string;
  userId: string;
  helperId: string;
  browserSessionId: string | null;
  objective: string | null;
  history: LearnerHistoryEntry[];
  materials: LearnerMaterial[];
  createdAt: string;
  updatedAt: string;
}

export interface LearnerMemoryDeps {
  query: SqlQuery;
  transaction: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>;
}

export interface LearnerMemoryScope {
  userId: string;
  helperId: string;
  browserSessionId: string;
  conversationId?: string | null;
  objective?: string | null;
}

interface MemoryRow {
  id: string;
  user_id: string;
  helper_id: string;
  browser_session_id: string | null;
  objective: string | null;
  history: unknown;
  materials: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

function defaultDeps(): LearnerMemoryDeps {
  return {
    query: (text, values) => queryRows(text, values),
    transaction: withTransaction,
  };
}

/** NFC then UTF-8 code points, capped so a snapshot is never split inside a surrogate pair. */
export function utf8Text(value: string, maxChars: number): string {
  const limited = Array.from(value.normalize('NFC')).slice(0, Math.max(0, maxChars)).join('');
  return new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(limited));
}

export function parseLearnerConversationId(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error('Learner conversation id is invalid');
  }
  return value.toLowerCase();
}

export function parseLearnerObjective(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Learner objective must be text');
  const objective = value.normalize('NFC').trim();
  if (!objective) return null;
  if (Array.from(objective).length > LEARNER_OBJECTIVE_CHARS) {
    throw new Error('Learner objective is too long');
  }
  return objective;
}

export function boundLearnerHistory(entries: LearnerHistoryEntry[]): LearnerHistoryEntry[] {
  const conversational = (entry: LearnerHistoryEntry) => entry.role === 'user' || /"action":"ask-user"/.test(entry.text);
  const important = entries.filter(conversational).slice(-LEARNER_HISTORY_LIMIT);
  const slots = LEARNER_HISTORY_LIMIT - important.length;
  const recent = slots > 0 ? entries.filter((entry) => !conversational(entry)).slice(-slots) : [];
  const retained = new Set([...important, ...recent]);
  return entries.filter((entry) => retained.has(entry)).map((entry) => ({
    role: entry.role,
    text: utf8Text(entry.text, LEARNER_HISTORY_CHARS),
    at: entry.at,
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.planId ? { planId: entry.planId } : {}),
  }));
}

export function addLearnerMaterial(
  materials: LearnerMaterial[],
  observed: { title?: string; url?: string; text?: string },
  at = new Date().toISOString(),
): LearnerMaterial[] {
  const text = utf8Text(observed.text ?? '', LEARNER_MATERIAL_CHARS).trim();
  const next = materials.map((item) => ({ ...item }));
  if (!text) return next.slice(-LEARNER_MATERIAL_LIMIT);
  const entry: LearnerMaterial = {
    text,
    title: utf8Text(observed.title ?? '', 200).trim(),
    url: utf8Text(observed.url ?? '', 500).trim(),
    at,
  };
  const duplicate = next.findIndex((item) => item.text === entry.text);
  if (duplicate >= 0) next.splice(duplicate, 1);
  next.push(entry);
  return next.slice(-LEARNER_MATERIAL_LIMIT);
}

export function displayLearnerHistory(
  history: LearnerHistoryEntry[],
): Array<{ role: 'user' | 'assistant'; text: string; url?: string }> {
  return boundLearnerHistory(history).map((entry) => ({
    role: entry.role,
    text: utf8Text(entry.text, LEARNER_HISTORY_CHARS),
    ...(entry.url ? { url: entry.url } : {}),
  }));
}

export function composeLearnerSnapshot(
  current: LearnerSnapshot,
  memory: { objective?: string | null; history: LearnerHistoryEntry[]; materials: LearnerMaterial[] } | null,
): LearnerSnapshot {
  const currentText = utf8Text(current.text ?? '', LEARNER_MATERIAL_CHARS);
  const snapshot: LearnerSnapshot = {
    title: current.title,
    url: current.url,
    text: currentText,
    choices: current.choices,
    buttons: current.buttons,
    ...(current.guidance ? { guidance: current.guidance } : {}),
  };
  if (!memory) return snapshot;
  const isConversation = (entry: LearnerHistoryEntry) => entry.role === 'user' || /"action":"ask-user"/.test(entry.text);
  const dialogue = fitLines(conversationLines(memory.history.filter(isConversation)), 3000);
  const actions = fitLines(conversationLines(memory.history.filter((entry) => !isConversation(entry))), 900);
  const conversation = [dialogue, actions ? `Recent proposed actions (not proof of success):\n${actions}` : ''].filter(Boolean).join('\n');
  const parts = [currentText];
  if (memory.objective) parts.push(`Operator goal: ${memory.objective}`);
  if (conversation) parts.push(`Prior conversation:\n${conversation}`);
  parts.push(MEMORY_NOTE);
  const materialBudget = Math.max(0, Math.min(LEARNER_CONTEXT_MATERIAL_CHARS, 24_000 - parts.join('\n\n').length - 40));
  const material = fitLines(materialLines(memory.materials, current.choices?.length ? currentText : undefined).filter((text) => text !== currentText), materialBudget);
  if (material) parts.push(`Retained course material:\n${material}`);
  snapshot.text = parts.filter((part) => part.length > 0).join('\n\n');
  return snapshot;
}

export async function ensureLearnerSession(
  input: LearnerMemoryScope,
  deps?: LearnerMemoryDeps,
): Promise<LearnerMemorySession> {
  const db = deps ?? defaultDeps();
  const objective = input.objective ?? null;
  return db.transaction(async (sql) => {
    await sql(learnerMemorySql.lockScope, [JSON.stringify([input.userId, input.helperId, input.browserSessionId])]);
    if (input.conversationId) {
      const existing = await lockById(sql, input, input.conversationId);
      if (!existing) throw new Error('Learner conversation was not found');
      if (objective && objective !== existing.objective) {
        return updateSession(sql, existing, { objective });
      }
      return existing;
    }
    const latest = await lockLatest(sql, input);
    if (latest) {
      if (objective && objective !== latest.objective) {
        return updateSession(sql, latest, { objective });
      }
      return latest;
    }
    const inserted = await sql<MemoryRow>(learnerMemorySql.insert, [
      input.userId,
      input.helperId,
      input.browserSessionId,
      objective,
      JSON.stringify([]),
      JSON.stringify([]),
    ]);
    const session = mapRow(inserted[0]);
    if (!session) throw new Error('Learner conversation could not be saved');
    return session;
  });
}

export async function appendPlanGuidance(
  input: LearnerMemoryScope & { conversationId: string; planId: string; guidance: string },
  deps?: LearnerMemoryDeps,
): Promise<LearnerMemorySession> {
  const db = deps ?? defaultDeps();
  const guidance = utf8Text(input.guidance, LEARNER_HISTORY_CHARS).trim();
  return db.transaction(async (sql) => {
    const existing = await lockById(sql, input, input.conversationId);
    if (!existing) throw new Error('Learner conversation was not found');
    if (!guidance || existing.history.some((entry) => entry.role === 'user' && entry.planId === input.planId)) {
      return existing;
    }
    return updateSession(sql, existing, {
      history: boundLearnerHistory([
        ...existing.history,
        { role: 'user', text: guidance, at: new Date().toISOString(), planId: input.planId },
      ]),
    });
  });
}

export async function readLearnerSessionForModel(
  input: LearnerMemoryScope & { conversationId: string },
  deps?: LearnerMemoryDeps,
): Promise<LearnerMemorySession | null> {
  const db = deps ?? defaultDeps();
  const rows = await db.query<MemoryRow>(learnerMemorySql.readModel, [
    input.conversationId,
    input.userId,
    input.helperId,
    input.browserSessionId,
  ]);
  return mapRow(rows[0]);
}

export async function readLearnerSessionForOperator(
  input: { userId: string; helperId: string; browserSessionId?: string | null },
  deps?: LearnerMemoryDeps,
): Promise<{ id: string; objective: string | null; history: Array<{ role: 'user' | 'assistant'; text: string; url?: string }> } | null> {
  const db = deps ?? defaultDeps();
  const rows = await db.query<{ id: string; objective: string | null; history: unknown }>(
    learnerMemorySql.readOperator,
    [input.userId, input.helperId, input.browserSessionId ?? null],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    objective: row.objective == null ? null : utf8Text(String(row.objective), LEARNER_OBJECTIVE_CHARS),
    history: displayLearnerHistory(parseHistory(row.history)),
  };
}

export async function recordLearnerTurn(
  input: LearnerMemoryScope & {
    conversationId: string;
    observed: { title?: string; url?: string; text?: string };
    decision: { action?: unknown; stop?: boolean; error?: string };
  },
  deps?: LearnerMemoryDeps,
): Promise<boolean> {
  const db = deps ?? defaultDeps();
  return db.transaction(async (sql) => {
    const existing = await lockById(sql, input, input.conversationId);
    if (!existing) return false;
    const decision = utf8Text(JSON.stringify({
      action: input.decision.action ?? null,
      stop: Boolean(input.decision.stop && !input.decision.action),
      error: input.decision.error ?? null,
    }), LEARNER_HISTORY_CHARS);
    await updateSession(sql, existing, {
      history: boundLearnerHistory([
        ...existing.history,
        { role: 'assistant', text: decision, at: new Date().toISOString(), ...(input.observed.url ? { url: input.observed.url.slice(0, 500) } : {}) },
      ]),
      materials: addLearnerMaterial(existing.materials, input.observed),
    });
    return true;
  });
}

function conversationLines(history: LearnerHistoryEntry[]): string[] {
  return history.map((entry) => `${entry.role}: ${entry.text}`);
}

function materialLines(materials: LearnerMaterial[], question?: string): string[] {
  if (!question) return materials.map((item) => item.text);
  const words = [...new Set(question.toLowerCase().match(/[a-z]{4,}/g) || [])].filter((word) => !['which', 'following', 'select', 'question', 'answer', 'device', 'features', 'this', 'that', 'with', 'from', 'have', 'does'].includes(word));
  const documents = materials.map((item) => new Set(item.text.toLowerCase().match(/[a-z]{4,}/g) || []));
  const frequency = new Map(words.map((word) => [word, documents.filter((document) => document.has(word)).length || 1]));
  return materials.map((item, index) => ({ text: item.text, index, score: words.reduce((score, word) => score + (documents[index].has(word) ? 1 / frequency.get(word)! : 0), 0) }))
    .sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.text);
}

function fitLines(lines: string[], maxChars: number): string {
  const selected: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line) continue;
    const separator = selected.length ? 1 : 0;
    if (used + separator + line.length > maxChars) {
      if (!selected.length) selected.push(line.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, ''));
      break;
    }
    selected.push(line);
    used += separator + line.length;
  }
  return selected.reverse().join('\n');
}

async function lockById(
  sql: SqlQuery,
  input: LearnerMemoryScope,
  conversationId: string,
): Promise<LearnerMemorySession | null> {
  const rows = await sql<MemoryRow>(learnerMemorySql.lockById, [
    conversationId,
    input.userId,
    input.helperId,
    input.browserSessionId,
  ]);
  return mapRow(rows[0]);
}

async function lockLatest(sql: SqlQuery, input: LearnerMemoryScope): Promise<LearnerMemorySession | null> {
  const rows = await sql<MemoryRow>(learnerMemorySql.lockLatest, [
    input.userId,
    input.helperId,
    input.browserSessionId,
  ]);
  return mapRow(rows[0]);
}

async function updateSession(
  sql: SqlQuery,
  existing: LearnerMemorySession,
  patch: { objective?: string | null; history?: LearnerHistoryEntry[]; materials?: LearnerMaterial[] },
): Promise<LearnerMemorySession> {
  const history = patch.history ?? existing.history;
  const materials = patch.materials ?? existing.materials;
  const objective = patch.objective === undefined ? existing.objective : patch.objective;
  const rows = await sql<MemoryRow>(learnerMemorySql.update, [
    existing.id,
    objective,
    JSON.stringify(history),
    JSON.stringify(materials),
    existing.userId,
    existing.helperId,
    existing.browserSessionId,
  ]);
  const session = mapRow(rows[0]);
  if (!session) throw new Error('Learner conversation could not be saved');
  return session;
}

function mapRow(row: MemoryRow | undefined): LearnerMemorySession | null {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    helperId: String(row.helper_id),
    browserSessionId: row.browser_session_id == null ? null : String(row.browser_session_id),
    objective: row.objective == null ? null : String(row.objective),
    history: parseHistory(row.history),
    materials: parseMaterials(row.materials),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseHistory(value: unknown): LearnerHistoryEntry[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const entries: LearnerHistoryEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    if (typeof record.text !== 'string' || typeof record.at !== 'string') continue;
    entries.push({
      role: record.role,
      text: record.text,
      at: record.at,
      ...(typeof record.planId === 'string' ? { planId: record.planId } : {}),
      ...(typeof record.url === 'string' ? { url: record.url.slice(0, 500) } : {}),
    });
  }
  return entries;
}

function parseMaterials(value: unknown): LearnerMaterial[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const materials: LearnerMaterial[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string') continue;
    materials.push({
      text: record.text,
      title: typeof record.title === 'string' ? record.title : '',
      url: typeof record.url === 'string' ? record.url : '',
      at: typeof record.at === 'string' ? record.at : '',
    });
  }
  return materials;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
