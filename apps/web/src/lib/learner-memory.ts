import { parseLearnerAction, type LearnerSnapshot } from '@quiztaker/core';
import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';
import { learnerQuestion } from '@/lib/guided-flow';

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
  requestId?: string;
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
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
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
): Array<{ role: 'user' | 'assistant'; text: string; url?: string; guidance?: boolean }> {
  return boundLearnerHistory(history).map((entry) => ({
    role: entry.role,
    text: utf8Text(entry.text, LEARNER_HISTORY_CHARS),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.requestId ? { guidance: true } : {}),
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

export async function appendLearnerGuidance(
  input: LearnerMemoryScope & { conversationId: string; requestId: string; text: string },
  deps?: LearnerMemoryDeps,
): Promise<LearnerMemorySession> {
  const db = deps ?? defaultDeps();
  const text = input.text.normalize('NFC').trim();
  if (!text || Array.from(text).length > LEARNER_HISTORY_CHARS) {
    throw new Error('Learner guidance is invalid');
  }
  if (!UUID_RE.test(input.requestId)) throw new Error('Learner guidance request id is invalid');
  const requestId = input.requestId.toLowerCase();
  return db.transaction(async (sql) => {
    const existing = await lockById(sql, input, input.conversationId);
    if (!existing) throw new Error('Learner conversation was not found');
    if (existing.history.some((entry) => entry.role === 'user' && entry.requestId === requestId)) {
      return existing;
    }
    return updateSession(sql, existing, {
      history: boundLearnerHistory([
        ...existing.history,
        { role: 'user', text, at: new Date().toISOString(), requestId },
      ]),
    });
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
): Promise<{ id: string; objective: string | null; history: Array<{ role: 'user' | 'assistant'; text: string; url?: string; guidance?: boolean }> } | null> {
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
    const summary = observedSummary(input.observed, input.decision);
    const payload = {
      action: input.decision.action ?? null,
      stop: Boolean(input.decision.stop && !input.decision.action),
      error: input.decision.error ?? null,
      ...(summary ? { observed: summary } : {}),
    };
    let encoded = JSON.stringify(payload);
    if (summary && Array.from(encoded).length > LEARNER_HISTORY_CHARS) {
      encoded = JSON.stringify({ action: payload.action, stop: payload.stop, error: payload.error });
    }
    const decision = utf8Text(encoded, LEARNER_HISTORY_CHARS);
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

export interface StoredLearnerPauseScope {
  userId: string;
  helperId: string;
  browserSessionId: string;
  conversationId: string;
}

/** Binding for a paused question. Only the stored job and plan inputs are read. */
export function storedLearnerPauseScope(stored: {
  userId: string;
  helperId: string;
  jobInput: unknown;
  planInput: unknown;
  planBrowserSessionId?: string | null;
}): StoredLearnerPauseScope | null {
  if (!stored.userId || !stored.helperId) return null;
  const fromJob = pauseBinding(stored.jobInput);
  const fromPlan = pauseBinding(stored.planInput);
  if (fromJob && fromPlan && (
    fromJob.conversationId !== fromPlan.conversationId
    || fromJob.browserSessionId !== fromPlan.browserSessionId
  )) return null;
  const binding = fromJob ?? fromPlan;
  if (!binding) return null;
  const planBrowser = typeof stored.planBrowserSessionId === 'string'
    ? stored.planBrowserSessionId.toLowerCase()
    : '';
  if (planBrowser && planBrowser !== binding.browserSessionId) return null;
  return { userId: stored.userId, helperId: stored.helperId, ...binding };
}

/**
 * Persist a helper-emitted LEARNER_QUESTION inside the caller's transaction.
 * The same deps are passed through to recordLearnerTurn so this does not open
 * a second database transaction. An identical trailing provider question is
 * kept, and its page URL is filled from the emitted line when missing.
 */
export async function recordLocalPausedQuestion(
  input: LearnerMemoryScope & { conversationId: string; output: string },
  deps?: LearnerMemoryDeps,
): Promise<boolean> {
  const paused = validatedPausedQuestion(input.output);
  const conversationId = safeConversationId(input.conversationId);
  if (!paused || !conversationId || !UUID_RE.test(input.browserSessionId)) return false;
  const db = deps ?? defaultDeps();
  const scope = { ...input, conversationId, browserSessionId: input.browserSessionId.toLowerCase() };
  return db.transaction(async (sql) => {
    const existing = await lockById(sql, scope, conversationId);
    if (!existing) return false;
    const last = existing.history.at(-1);
    const previous = last ? askUserFromHistory(last) : null;
    if (last && previous && sameAskUser(previous, paused)) {
      if (paused.url && last.url !== paused.url) {
        const history = existing.history.slice(0, -1).concat({ ...last, url: paused.url });
        await updateSession(sql, existing, { history: boundLearnerHistory(history) });
      }
      return true;
    }
    return recordLearnerTurn({
      ...scope,
      observed: { ...(paused.url ? { url: paused.url } : {}) },
      decision: {
        action: {
          action: 'ask-user',
          question: paused.question,
          ...(paused.options ? { options: paused.options } : {}),
        },
      },
    }, { query: sql, transaction: async (fn) => fn(sql) });
  });
}

function pauseBinding(value: unknown): { conversationId: string; browserSessionId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const conversationId = safeConversationId(record.conversationId);
  const target = record.target;
  const browserSessionId = target && typeof target === 'object'
    ? (target as { browserSessionId?: unknown }).browserSessionId
    : null;
  if (!conversationId || typeof browserSessionId !== 'string' || !UUID_RE.test(browserSessionId)) return null;
  return { conversationId, browserSessionId: browserSessionId.toLowerCase() };
}

function safeConversationId(value: unknown): string | null {
  try {
    return parseLearnerConversationId(value);
  } catch {
    return null;
  }
}

function validatedPausedQuestion(output: string): { question: string; options?: string[]; url?: string } | null {
  const parsed = learnerQuestion(output);
  if (!parsed) return null;
  const decision = parseLearnerAction({
    action: 'ask-user',
    question: parsed.question,
    ...(parsed.options.length ? { options: parsed.options } : {}),
  }, { url: parsed.url } satisfies LearnerSnapshot);
  if (!decision.ok || decision.action.action !== 'ask-user') return null;
  return {
    question: decision.action.question,
    ...(decision.action.options?.length ? { options: decision.action.options } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
  };
}

function askUserFromHistory(entry: LearnerHistoryEntry): { question: string; options?: string[] } | null {
  if (entry.role !== 'assistant') return null;
  try {
    const action = JSON.parse(entry.text)?.action;
    if (!action || action.action !== 'ask-user' || typeof action.question !== 'string') return null;
    const options = Array.isArray(action.options)
      ? action.options.filter((option: unknown): option is string => typeof option === 'string')
      : [];
    return { question: action.question, ...(options.length ? { options } : {}) };
  } catch {
    return null;
  }
}

function sameAskUser(
  left: { question: string; options?: string[] },
  right: { question: string; options?: string[] },
): boolean {
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  return left.question === right.question
    && leftOptions.length === rightOptions.length
    && leftOptions.every((option, index) => option === rightOptions[index]);
}

function observedSummary(
  observed: { title?: string; url?: string; text?: string },
  decision: { action?: unknown },
): string | null {
  const title = utf8Text(observed.title ?? '', 120).trim();
  const action = decision.action && typeof decision.action === 'object'
    ? decision.action as { action?: unknown; targetId?: unknown }
    : null;
  const targetId = typeof action?.targetId === 'string' ? utf8Text(action.targetId, 80).trim() : '';
  const parts: string[] = [];
  if (title) parts.push(`Observed page: ${title}`);
  else if (utf8Text(observed.url ?? '', 500).trim()) parts.push('Observed the current course page');
  if (targetId && action?.action !== 'ask-user') parts.push(`Proposed target: ${targetId}`);
  const summary = parts.join('. ');
  return summary ? utf8Text(summary, 240) : null;
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
      ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
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
