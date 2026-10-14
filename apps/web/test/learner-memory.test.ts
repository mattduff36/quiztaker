import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { SqlQuery } from '../src/lib/db.js';
import { LEARNER_SYSTEM_PROMPT, boundLearnerSnapshot } from '../src/lib/learner.js';
import {
  LEARNER_DISPLAY_CHARS,
  LEARNER_HISTORY_LIMIT,
  LEARNER_MATERIAL_CHARS,
  LEARNER_MATERIAL_LIMIT,
  addLearnerMaterial,
  appendLearnerGuidance,
  appendPlanGuidance,
  boundLearnerHistory,
  composeLearnerSnapshot,
  displayLearnerHistory,
  ensureLearnerSession,
  learnerMemorySql,
  parseLearnerConversationId,
  parseLearnerObjective,
  readLearnerSessionForModel,
  readLearnerSessionForOperator,
  recordLearnerTurn,
  recordLocalPausedQuestion,
  storedLearnerPauseScope,
  utf8Text,
  type LearnerHistoryEntry,
  type LearnerMaterial,
  type LearnerMemoryDeps,
} from '../src/lib/learner-memory.js';

const userA = 'user-a';
const userB = 'user-b';
const helperA = '11111111-1111-4111-8111-111111111111';
const helperB = '22222222-2222-4222-8222-222222222222';
const browserA = '33333333-3333-4333-8333-333333333333';
const browserB = '44444444-4444-4444-8444-444444444444';

interface MemoryRow {
  id: string;
  user_id: string;
  helper_id: string;
  browser_session_id: string | null;
  objective: string | null;
  history: unknown;
  materials: unknown;
  created_at: string;
  updated_at: string;
}

function createHarness(): LearnerMemoryDeps & { rows: MemoryRow[]; queries: string[] } {
  const rows: MemoryRow[] = [];
  const queries: string[] = [];
  let tick = 0;
  const stamp = () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
  };
  const query: SqlQuery = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (sql === learnerMemorySql.lockScope) return [];
    if (sql === learnerMemorySql.lockById || sql === learnerMemorySql.readModel) {
      const [id, userId, helperId, browserSessionId] = values;
      return rows.filter((row) => (
        row.id === id
        && row.user_id === userId
        && row.helper_id === helperId
        && row.browser_session_id === browserSessionId
      )).map(cloneRow) as T[];
    }
    if (sql === learnerMemorySql.lockLatest) {
      const [userId, helperId, browserSessionId] = values;
      return rows
        .filter((row) => row.user_id === userId && row.helper_id === helperId && row.browser_session_id === browserSessionId)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 1)
        .map(cloneRow) as T[];
    }
    if (sql === learnerMemorySql.insert) {
      const [userId, helperId, browserSessionId, objective, history, materials] = values;
      const at = stamp();
      const row: MemoryRow = {
        id: randomUUID(),
        user_id: String(userId),
        helper_id: String(helperId),
        browser_session_id: browserSessionId == null ? null : String(browserSessionId),
        objective: objective == null ? null : String(objective),
        history: JSON.parse(String(history)),
        materials: JSON.parse(String(materials)),
        created_at: at,
        updated_at: at,
      };
      rows.push(row);
      return [cloneRow(row)] as T[];
    }
    if (sql === learnerMemorySql.update) {
      const [id, objective, history, materials, userId, helperId, browserSessionId] = values;
      const row = rows.find((item) => (
        item.id === id
        && item.user_id === userId
        && item.helper_id === helperId
        && item.browser_session_id === browserSessionId
      ));
      if (!row) return [] as T[];
      row.objective = objective == null ? null : String(objective);
      row.history = JSON.parse(String(history));
      row.materials = JSON.parse(String(materials));
      row.updated_at = stamp();
      return [cloneRow(row)] as T[];
    }
    if (sql === learnerMemorySql.readOperator) {
      const [userId, helperId, browserSessionId] = values;
      return rows
        .filter((row) => (
          row.user_id === userId
          && row.helper_id === helperId
          && (browserSessionId == null || row.browser_session_id === browserSessionId)
        ))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 1)
        .map((row) => ({ id: row.id, objective: row.objective, history: structuredClone(row.history) })) as T[];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return {
    rows,
    queries,
    query,
    transaction: async (fn) => fn(query),
  };
}

function cloneRow(row: MemoryRow): MemoryRow {
  return structuredClone(row);
}

test('bounds history and distinct material snapshots', () => {
  const history: LearnerHistoryEntry[] = Array.from({ length: LEARNER_HISTORY_LIMIT + 5 }, (_, index) => ({
    role: 'assistant',
    text: `decision-${index}`,
    at: '2026-01-01T00:00:00.000Z',
  }));
  const bounded = boundLearnerHistory(history);
  assert.equal(bounded.length, LEARNER_HISTORY_LIMIT);
  assert.equal(bounded[0]?.text, 'decision-5');
  assert.equal(bounded.at(-1)?.text, `decision-${LEARNER_HISTORY_LIMIT + 4}`);

  let materials: LearnerMaterial[] = [];
  for (let index = 0; index < LEARNER_MATERIAL_LIMIT + 1; index += 1) {
    materials = addLearnerMaterial(materials, { text: `${index}-${'x'.repeat(LEARNER_MATERIAL_CHARS + 50)}` }, `2026-01-01T00:00:${index.toString().padStart(2, '0')}.000Z`);
  }
  assert.equal(materials.length, LEARNER_MATERIAL_LIMIT);
  assert.equal(materials.some((item) => item.text.startsWith('0-')), false);
  assert.equal(materials[0]?.text.startsWith('1-'), true);
  assert.equal(materials.every((item) => item.text.length === LEARNER_MATERIAL_CHARS), true);
  const again = addLearnerMaterial(materials, { text: materials[3]?.text ?? '' });
  assert.equal(again.length, LEARNER_MATERIAL_LIMIT);
  assert.equal(again.at(-1)?.text, materials[3]?.text);
});

test('utf-8 text keeps whole code points', () => {
  assert.equal(utf8Text('🙂🙂🙂', 2), '🙂🙂');
  assert.equal(Array.from(utf8Text(`é${'x'.repeat(20)}`, 2)).length, 2);
});

test('injected database enforces owner, helper, browser session, dedup, and history bounds', async () => {
  const db = createHarness();
  const scope = { userId: userA, helperId: helperA, browserSessionId: browserA };
  const created = await ensureLearnerSession({ ...scope, objective: 'Finish the module' }, db);
  const reused = await ensureLearnerSession(scope, db);
  assert.equal(reused.id, created.id);
  assert.equal(db.rows.length, 1);
  const otherBrowser = await ensureLearnerSession({ ...scope, browserSessionId: browserB, objective: 'Other tab' }, db);
  assert.notEqual(otherBrowser.id, created.id);

  await assert.rejects(
    ensureLearnerSession({ ...scope, userId: userB, conversationId: created.id }, db),
    /Learner conversation was not found/,
  );
  await assert.rejects(
    ensureLearnerSession({ ...scope, helperId: helperB, conversationId: created.id }, db),
    /Learner conversation was not found/,
  );
  await assert.rejects(
    ensureLearnerSession({ ...scope, browserSessionId: browserB, conversationId: created.id }, db),
    /Learner conversation was not found/,
  );
  assert.equal(await readLearnerSessionForModel({ ...scope, userId: userB, conversationId: created.id }, db), null);
  assert.equal(await readLearnerSessionForOperator({ userId: userB, helperId: helperA }, db), null);

  const planId = randomUUID();
  await appendPlanGuidance({ ...scope, conversationId: created.id, planId, guidance: 'The reservoir answer is 42' }, db);
  await appendPlanGuidance({ ...scope, conversationId: created.id, planId, guidance: 'The reservoir answer is 42' }, db);
  for (let index = 0; index < 3; index += 1) {
    await recordLearnerTurn({
      ...scope,
      conversationId: created.id,
      observed: { title: 'Page', url: 'https://example.test/quiz', text: 'PAGE-BODY-MARKER targetId b1' },
      decision: { action: { action: 'ask-user', question: 'Which module?', options: ['Module 1'] } },
    }, db);
  }
  const deduped = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  assert.equal(deduped?.materials.length, 1);
  assert.equal(deduped?.history.filter((entry) => entry.role === 'user' && entry.planId === planId).length, 1);
  for (let index = 0; index < Math.max(LEARNER_HISTORY_LIMIT, LEARNER_MATERIAL_LIMIT); index += 1) {
    await recordLearnerTurn({
      ...scope,
      conversationId: created.id,
      observed: { text: `distinct-page-${index}` },
      decision: { stop: true, error: `stop-${index}` },
    }, db);
  }
  const stored = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  assert.ok(stored);
  assert.equal(stored.history.length, LEARNER_HISTORY_LIMIT);
  assert.equal(stored.history.some((entry) => entry.planId === planId), true);
  assert.equal(stored.materials.length, LEARNER_MATERIAL_LIMIT);
  assert.ok(stored.materials.every((item) => item.text.length <= LEARNER_MATERIAL_CHARS));
  assert.ok(db.queries.includes(learnerMemorySql.lockById));
  assert.match(learnerMemorySql.lockById, /for update/);
  assert.match(learnerMemorySql.lockLatest, /for update/);
  assert.match(learnerMemorySql.readModel, /user_id = \$2 and helper_id = \$3 and browser_session_id = \$4/);
});

test('a later job keeps the prior answer and only the new clickable controls', async () => {
  const db = createHarness();
  const scope = { userId: userA, helperId: helperA, browserSessionId: browserA };
  const first = await ensureLearnerSession({ ...scope, objective: 'Finish the module' }, db);
  await appendPlanGuidance({
    ...scope,
    conversationId: first.id,
    planId: randomUUID(),
    guidance: 'The reservoir answer is 42',
  }, db);
  await recordLearnerTurn({
    ...scope,
    conversationId: first.id,
    observed: { text: 'PAGE-BODY-MARKER targetId b1' },
    decision: { action: { action: 'ask-user', question: 'Which module?', options: ['Module 1'] } },
  }, db);
  await appendPlanGuidance({
    ...scope,
    conversationId: first.id,
    planId: randomUUID(),
    guidance: 'Continue from the answered reservoir question',
  }, db);
  const retained = await readLearnerSessionForModel({ ...scope, conversationId: first.id }, db);
  const model = boundLearnerSnapshot(composeLearnerSnapshot({
    text: 'Question 2',
    guidance: ` ${'g'.repeat(2500)}`,
    buttons: [{ id: 'b9', name: 'Next' }],
    choices: [{ id: 'c9', name: 'Other' }],
  }, retained));
  assert.equal(model.text?.startsWith('Question 2'), true);
  assert.ok((model.text?.indexOf('Question 2') ?? -1) < (model.text?.indexOf('42') ?? -1));
  assert.match(model.text ?? '', /Which module\?/);
  assert.match(model.text ?? '', /Read retained course material before assessment/);
  assert.equal(model.guidance?.length, 2000);
  assert.deepEqual(model.buttons, [{ id: 'b9', name: 'Next' }]);
  assert.deepEqual(model.choices, [{ id: 'c9', name: 'Other' }]);
  assert.equal(model.buttons?.some((item) => item.id === 'b1'), false);

  const operator = await readLearnerSessionForOperator({
    userId: userA,
    helperId: helperA,
    browserSessionId: browserA,
  }, db);
  assert.equal(operator?.id, first.id);
  assert.equal(operator?.objective, 'Finish the module');
  assert.equal(JSON.stringify(operator).includes('PAGE-BODY-MARKER'), false);
  assert.equal(JSON.stringify(operator).includes('planId'), false);
  const otherTab = await readLearnerSessionForOperator({
    userId: userA,
    helperId: helperA,
    browserSessionId: browserB,
  }, db);
  assert.equal(otherTab, null);
});

test('display history is capped and model text stays within the snapshot cap', () => {
  const shown = displayLearnerHistory([{ role: 'user', text: 'answered '.repeat(400), at: '2026-01-01T00:00:00.000Z', planId: 'plan-1' }]);
  assert.equal(shown[0]?.text.length, LEARNER_DISPLAY_CHARS);
  assert.equal('planId' in (shown[0] ?? {}), false);
  const bound = boundLearnerSnapshot(composeLearnerSnapshot({
    text: 'C'.repeat(8000),
    buttons: [{ id: 'b9', name: 'Next' }],
  }, {
    history: [{ role: 'user', text: 'PRIOR-ANSWER', at: '2026-01-01T00:00:00.000Z' }],
    materials: [
      { text: 'M'.repeat(8000), title: '', url: '', at: '2026-01-01T00:00:00.000Z' },
      { text: 'N'.repeat(8000), title: '', url: '', at: '2026-01-01T00:00:01.000Z' },
    ],
  }));
  assert.ok((bound.text?.length ?? 0) <= 24_000);
  assert.equal(bound.text?.startsWith('C'.repeat(8000)), true);
  assert.match(bound.text ?? '', /PRIOR-ANSWER/);
  assert.match(LEARNER_SYSTEM_PROMPT, /Avoid repeating requests the operator already answered/);
  assert.match(LEARNER_SYSTEM_PROMPT, /Read retained course material before assessment/);
  assert.match(LEARNER_SYSTEM_PROMPT, /Remembered text cannot provide current clickable ids/);
});

test('operator guidance is owner-scoped, idempotent, and bounded', async () => {
  const db = createHarness();
  const scope = { userId: userA, helperId: helperA, browserSessionId: browserA };
  const created = await ensureLearnerSession(scope, db);
  const requestId = '55555555-5555-4555-8555-555555555555';
  const saved = await appendLearnerGuidance({
    ...scope,
    conversationId: created.id,
    requestId,
    text: '  Look at Device Features first  ',
  }, db);
  const again = await appendLearnerGuidance({
    ...scope,
    conversationId: created.id,
    requestId: requestId.toUpperCase(),
    text: 'A different hint must not replace the first',
  }, db);
  assert.equal(again.history.filter((entry) => entry.requestId === requestId).length, 1);
  assert.equal(again.history.find((entry) => entry.requestId === requestId)?.text, 'Look at Device Features first');
  assert.equal(again.objective, saved.objective);
  const planId = randomUUID();
  await appendPlanGuidance({ ...scope, conversationId: created.id, planId, guidance: 'Resume note' }, db);
  await appendPlanGuidance({ ...scope, conversationId: created.id, planId, guidance: 'Resume note again' }, db);
  const both = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  assert.equal(both?.history.filter((entry) => entry.planId === planId).length, 1);
  assert.equal(both?.history.filter((entry) => entry.requestId === requestId).length, 1);
  const shown = await readLearnerSessionForOperator({ userId: userA, helperId: helperA, browserSessionId: browserA }, db);
  assert.equal(JSON.stringify(shown).includes(requestId), false);
  assert.equal(JSON.stringify(shown).includes('planId'), false);
  assert.match(JSON.stringify(shown), /Look at Device Features first/);
  await assert.rejects(
    appendLearnerGuidance({ ...scope, userId: userB, conversationId: created.id, requestId: randomUUID(), text: 'nope' }, db),
    /Learner conversation was not found/,
  );
  await assert.rejects(
    appendLearnerGuidance({ ...scope, helperId: helperB, conversationId: created.id, requestId: randomUUID(), text: 'nope' }, db),
    /Learner conversation was not found/,
  );
  await assert.rejects(
    appendLearnerGuidance({ ...scope, browserSessionId: browserB, conversationId: created.id, requestId: randomUUID(), text: 'nope' }, db),
    /Learner conversation was not found/,
  );
  assert.equal((await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db))?.history.length, both?.history.length);
  await assert.rejects(
    appendLearnerGuidance({ ...scope, conversationId: created.id, requestId, text: '   ' }, db),
    /Learner guidance is invalid/,
  );
  await assert.rejects(
    appendLearnerGuidance({ ...scope, conversationId: created.id, requestId: randomUUID(), text: 'é'.repeat(2001) }, db),
    /Learner guidance is invalid/,
  );
  const exact = await appendLearnerGuidance({
    ...scope,
    conversationId: created.id,
    requestId: randomUUID(),
    text: `🙂${'é'.repeat(1999)}`,
  }, db);
  assert.equal(Array.from(exact.history.at(-1)?.text ?? '').length, 2000);
  await assert.rejects(
    appendLearnerGuidance({ ...scope, conversationId: created.id, requestId: 'not-a-uuid', text: 'hint' }, db),
    /request id is invalid/,
  );
  assert.equal(db.rows.length, 1);
});

test('recorded turns summarise the observed page without claiming the proposal finished', async () => {
  const db = createHarness();
  const scope = { userId: userA, helperId: helperA, browserSessionId: browserA };
  const created = await ensureLearnerSession(scope, db);
  await recordLearnerTurn({
    ...scope,
    conversationId: created.id,
    observed: { title: 'Device Features', url: 'https://example.test/course', text: 'SECRET-BODY' },
    decision: { action: { action: 'click', targetId: 'b7' } },
  }, db);
  const stored = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  const text = stored?.history.at(-1)?.text ?? '';
  const parsed = JSON.parse(text) as { observed?: string; action?: { action?: string }; completed?: unknown };
  assert.equal(parsed.observed, 'Observed page: Device Features. Proposed target: b7');
  assert.equal(parsed.action?.action, 'click');
  assert.equal(parsed.completed, undefined);
  assert.equal(/complet|clicked/i.test(parsed.observed ?? ''), false);
  assert.equal(text.includes('SECRET-BODY'), false);
});

test('conversation id and objective parsers reject unbounded input', () => {
  assert.equal(parseLearnerConversationId(null), null);
  assert.equal(parseLearnerConversationId(helperA), helperA);
  assert.throws(() => parseLearnerConversationId('not-a-uuid'), /invalid/);
  assert.equal(parseLearnerObjective('  Finish module  '), 'Finish module');
  assert.throws(() => parseLearnerObjective('x'.repeat(1001)), /too long/);
  assert.throws(() => parseLearnerObjective(12), /must be text/);
});


test('navigation cannot evict user requests and pending questions restore with their page', () => {
  const history: LearnerHistoryEntry[] = [
    { role: 'user', text: 'Read Device Features then its assessment', at: '2026-01-01' },
    ...Array.from({ length: 70 }, () => ({ role: 'assistant' as const, text: '{"action":{"action":"click","targetId":"b1"}}', at: '2026-01-01' })),
    { role: 'assistant', text: JSON.stringify({ action: { action: 'ask-user', question: 'q'.repeat(500), options: ['Done, resume now'] } }), at: '2026-01-01', url: 'https://example.com/course' },
  ];
  const bounded = boundLearnerHistory(history);
  assert.equal(bounded.length, 40);
  assert.equal(bounded[0].role, 'user');
  const shown = displayLearnerHistory(bounded).at(-1)!;
  assert.equal(JSON.parse(shown.text).action.question.length, 500);
  assert.equal(shown.url, 'https://example.com/course');
  const composed = composeLearnerSnapshot({ text: 'current page' }, { objective: 'Read Device Features first', history: bounded, materials: [] });
  assert.match(composed.text!, /Operator goal: Read Device Features first/);
});


test('forty conversation entries leave no room for navigation history', () => {
  const history: LearnerHistoryEntry[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `request ${i}`, at: '2026-01-01' })),
    ...Array.from({ length: 100 }, () => ({ role: 'assistant' as const, text: '{"action":{"action":"click","targetId":"b1"}}', at: '2026-01-01' })),
  ];
  assert.equal(boundLearnerHistory(history).length, 40);
});


test('quiz context retrieves relevant earlier material rather than only the last pages', () => {
  const material = (text: string) => ({ text, title: 'Device Features', url: 'https://example.com/course', at: '2026-01-01' });
  const snapshot = composeLearnerSnapshot({ text: 'Which searchable PDF feature uses OCR?', choices: [{ id: 'c1', name: 'OCR' }] }, {
    history: [], materials: [material('EARLIER-FACT: Searchable PDF uses OCR to make scanned text searchable.'), ...Array.from({ length: 12 }, (_, i) => material(`Unrelated fax material ${i} ` + 'x'.repeat(7000)))],
  });
  assert.match(snapshot.text!, /EARLIER-FACT/);
  assert.ok(snapshot.text!.length <= 24000);
});

test('local pause questions persist for the stored job scope and do not duplicate the provider question', async () => {
  const db = createHarness();
  const scope = { userId: userA, helperId: helperA, browserSessionId: browserA };
  const created = await ensureLearnerSession(scope, db);
  const pausedUrl = 'https://content.example/module';
  const question = 'Open the intended question or module, then resume.';
  const line = `progress\nLEARNER_QUESTION ${JSON.stringify({ question, url: pausedUrl })}\n`;
  const storedInput = {
    capabilityId: 'quiz-learn',
    conversationId: created.id,
    target: { browserSessionId: browserA },
    data: { conversationId: '55555555-5555-4555-8555-555555555555', browserSessionId: browserB },
  };
  assert.deepEqual(storedLearnerPauseScope({
    userId: userA,
    helperId: helperA,
    jobInput: storedInput,
    planInput: storedInput,
    planBrowserSessionId: browserA,
  }), { userId: userA, helperId: helperA, browserSessionId: browserA, conversationId: created.id });
  assert.deepEqual(storedLearnerPauseScope({
    userId: userA,
    helperId: helperA,
    jobInput: {},
    planInput: { conversationId: created.id, target: { browserSessionId: browserA.toUpperCase() } },
    planBrowserSessionId: null,
  }), { userId: userA, helperId: helperA, browserSessionId: browserA, conversationId: created.id });
  assert.equal(storedLearnerPauseScope({
    userId: userA,
    helperId: helperA,
    jobInput: { conversationId: created.id, target: { browserSessionId: browserA } },
    planInput: { conversationId: created.id, target: { browserSessionId: browserB } },
    planBrowserSessionId: browserA,
  }), null);
  assert.equal(storedLearnerPauseScope({
    userId: userA,
    helperId: helperA,
    jobInput: { conversationId: created.id, target: { browserSessionId: browserA } },
    planInput: { conversationId: created.id, target: { browserSessionId: browserA } },
    planBrowserSessionId: browserB,
  }), null);
  assert.equal(storedLearnerPauseScope({
    userId: userA,
    helperId: helperA,
    jobInput: { conversationId: 'client-supplied', browserSessionId: browserB },
    planInput: null,
  }), null);

  await recordLearnerTurn({
    ...scope,
    conversationId: created.id,
    observed: { title: 'Module' },
    decision: { action: { action: 'ask-user', question } },
  }, db);
  assert.equal(await recordLocalPausedQuestion({ ...scope, conversationId: created.id, output: line }, db), true);
  const paused = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  assert.equal(paused?.history.filter((entry) => entry.role === 'assistant').length, 1);
  assert.equal(paused?.history.at(-1)?.url, pausedUrl);
  const savedAt = db.rows.find((row) => row.id === created.id)?.updated_at;
  assert.equal(await recordLocalPausedQuestion({ ...scope, conversationId: created.id, output: line }, db), true);
  assert.equal(db.rows.find((row) => row.id === created.id)?.updated_at, savedAt);
  assert.equal(await recordLocalPausedQuestion({ ...scope, userId: userB, conversationId: created.id, output: line }, db), false);
  assert.equal(await recordLocalPausedQuestion({ ...scope, helperId: helperB, conversationId: created.id, output: line }, db), false);
  assert.equal(await recordLocalPausedQuestion({ ...scope, browserSessionId: browserB, conversationId: created.id, output: line }, db), false);
  assert.equal(await recordLocalPausedQuestion({ ...scope, conversationId: created.id, output: 'LEARNER_QUESTION {"question":""}' }, db), false);
  const other = `LEARNER_QUESTION ${JSON.stringify({ question: 'Which module?', options: ['Module 1'], url: 'http://content.example/other' })}`;
  assert.equal(await recordLocalPausedQuestion({ ...scope, conversationId: created.id, output: other }, db), true);
  const stored = await readLearnerSessionForModel({ ...scope, conversationId: created.id }, db);
  assert.equal(stored?.history.filter((entry) => entry.role === 'assistant').length, 2);
  assert.deepEqual(JSON.parse(stored!.history.at(-1)!.text).action, {
    action: 'ask-user',
    question: 'Which module?',
    options: ['Module 1'],
  });
  assert.equal(stored?.history.at(-1)?.url, 'http://content.example/other');
  assert.equal(stored?.userId, userA);
  assert.equal(stored?.helperId, helperA);
  assert.equal(stored?.browserSessionId, browserA);
});
