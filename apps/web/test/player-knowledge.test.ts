import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SqlQuery } from '../src/lib/db.js';
import { withStandingInstructions } from '../src/lib/learner.js';
import { PlayerKnowledgePanel } from '../src/components/player-knowledge-panel.js';
import {
  PLAYER_PROFILES, PLAYER_CONTEXT_CHARS, identifyPlayer, mergePlayerObservation,
  checkOfficialSources, observePlayerKnowledge, recordPlayerJobOutcome, withPlayerKnowledge,
  type PlayerEvidence, type PlayerKnowledgeDeps,
} from '../src/lib/player-knowledge.js';

const snapshot = { title: 'Paper lesson', url: 'https://course.invalid/lms/player?secret=never-store',
  text: '[Player DOM evidence: dki-claro-padding,dki-elements,dki-flip-card]\nObserved material.' };
const now = new Date('2026-11-03T18:00:00Z');

function fixture() {
  const rows = new Map<string, { id: string; fingerprint: string; status: string; evidence: PlayerEvidence }>();
  const observations = new Set<string>();
  const reviews = new Map<string, string>();
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const requested: string[] = [];
  let date = now;
  let fail = false;
  let documentText = '<html>official documentation</html>';
  const query: SqlQuery = async <T>(text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes('pg_advisory')) return [];
    if (text.includes('insert into attempt_events')) {
      const key = `${text.includes("'player-outcome'") ? 'outcome' : 'observation'}:${values[0]}:${values[1]}:${values[3]}:${values[4] || ''}`;
      if (observations.has(key)) return [];
      observations.add(key);
      return [{ id: observations.size }] as T[];
    }
    if (text.includes('select id, fingerprint')) {
      if (text.includes('jsonb_exists')) return [...rows.entries()].filter(([key, row]) => key.startsWith(`${values[0]}:`) && row.evidence.observedAttemptIds.includes(String(values[3]))).map(([, row]) => structuredClone(row)) as T[];
      const row = rows.get(`${values[0]}:${values[3]}`);
      return row ? [structuredClone(row)] as T[] : [];
    }
    if (text.includes('insert into strategies')) {
      const key = `${values[0]}:${values[3]}`;
      const row = { id: rows.get(key)?.id || `row-${rows.size + 1}`, fingerprint: String(values[3]), status: 'candidate', evidence: JSON.parse(String(values[4])) as PlayerEvidence };
      rows.set(key, row);
      return [{ id: row.id }] as T[];
    }
    if (text.includes('insert into review_items')) {
      reviews.set(`${values[0]}:${values[1]}`, String(values[3]));
      return [];
    }
    if (text.includes('update strategies set evidence')) {
      const row = [...rows.entries()].find(([key, item]) => key.startsWith(`${values[1]}:`) && item.id === values[0])?.[1];
      assert.ok(row);
      row.evidence = JSON.parse(String(values[2]));
      return [];
    }
    throw new Error(`Unexpected test SQL: ${text}`);
  };
  const deps: PlayerKnowledgeDeps = {
    query, transaction: fn => fn(query), now: () => date,
    fetch: async (url, init) => {
      requested.push(String(url));
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      if (fail) throw new Error('offline');
      return new Response(documentText, { headers: { 'content-type': 'text/html' } });
    },
  };
  return { rows, reviews, calls, requested, deps, setDate: (value: Date) => { date = value; }, failFetch: () => { fail = true; }, changeDocument: () => { documentText = '<html>changed documentation</html>'; } };
}

test('family inference requires evidence, remains version-agnostic and does not retain session URLs', () => {
  const player = identifyPlayer(snapshot);
  assert.equal(player.familyId, 'dominknow');
  assert.match(player.name, /probable.*version unknown/);
  assert.equal(identifyPlayer({ text: '[Player DOM evidence: dki-elements]' }).familyId, 'unknown');
  assert.equal(identifyPlayer({ title: 'dominKnow Claro version 99', text: 'dominKnow' }).familyId, 'unknown');
  const unknownA = identifyPlayer({ url: snapshot.url });
  const unknownB = identifyPlayer({ url: snapshot.url.replace('never-store', 'changed') });
  assert.equal(unknownA.fingerprint, unknownB.fingerprint);
  assert.doesNotMatch(JSON.stringify(player), /secret|never-store|course.invalid/);
});

test('official checks use fixed URLs, cap content and never claim new semantic research', async () => {
  const requested: string[] = [];
  const profile = { ...PLAYER_PROFILES[0], sources: [{ title: 'bad', url: 'http://127.0.0.1/private' }] };
  const checked = await checkOfficialSources(profile, now.toISOString(), async url => {
    requested.push(String(url));
    return new Response('x'.repeat(256001), { headers: { 'content-type': 'text/html' } });
  });
  assert.deepEqual(requested, PLAYER_PROFILES[0].sources.slice(0, 2).map(source => source.url));
  assert.equal(checked.filter(source => source.available === false).length, 2);
  assert.equal(checked[2].checkedAt, undefined);
  assert.equal(PLAYER_PROFILES[0].researchedAt, '2026-11-03');
});

test('observations dedupe across steps, stay user-scoped and use cached official checks', async () => {
  const f = fixture();
  await observePlayerKnowledge({ userId: 'a', attemptId: 'attempt-1', snapshot }, f.deps);
  await observePlayerKnowledge({ userId: 'a', attemptId: 'attempt-1', snapshot }, f.deps);
  const second = await observePlayerKnowledge({ userId: 'a', attemptId: 'attempt-2', snapshot }, f.deps);
  assert.equal(second.observations, 2);
  assert.equal(f.requested.length, 2);
  await observePlayerKnowledge({ userId: 'b', attemptId: 'attempt-1', snapshot }, f.deps);
  assert.equal(f.rows.size, 2);
  assert.equal(f.rows.get('b:dominknow')?.evidence.observations, 1);
  assert.ok(f.calls.filter(call => call.text.includes('from strategies')).every(call => call.text.includes('user_id = $1')));
  assert.doesNotMatch(JSON.stringify([...f.rows.values()]), /never-store/);
});

test('source failures back off; changed documents queue research without changing reviewed findings date', async () => {
  const offline = fixture();
  offline.failFetch();
  await observePlayerKnowledge({ userId: 'a', attemptId: 'first', snapshot }, offline.deps);
  await observePlayerKnowledge({ userId: 'a', attemptId: 'second', snapshot }, offline.deps);
  assert.equal(offline.requested.length, 2);
  offline.setDate(new Date(now.getTime() + 25 * 60 * 60_000));
  await observePlayerKnowledge({ userId: 'a', attemptId: 'third', snapshot }, offline.deps);
  assert.equal(offline.requested.length, 4);

  const f = fixture();
  await observePlayerKnowledge({ userId: 'a', attemptId: 'first', snapshot }, f.deps);
  f.setDate(new Date(now.getTime() + 31 * 24 * 60 * 60_000));
  f.changeDocument();
  const changed = await observePlayerKnowledge({ userId: 'a', attemptId: 'second', snapshot }, f.deps);
  assert.equal(changed.researchedAt, '2026-11-03');
  assert.equal(f.reviews.size, 1);
  assert.match([...f.reviews.values()][0], /documentation page changed/);
});

test('unknown players queue one review without arbitrary outbound fetch or fabricated guidance', async () => {
  const f = fixture();
  const unknown = { url: 'http://127.0.0.1/private', text: '[Player DOM evidence: unrecognized]' };
  const first = await observePlayerKnowledge({ userId: 'a', attemptId: 'first', snapshot: unknown }, f.deps);
  await observePlayerKnowledge({ userId: 'a', attemptId: 'second', snapshot: unknown }, f.deps);
  assert.equal(f.reviews.size, 1);
  assert.equal(f.requested.length, 0);
  assert.equal(first.findings.length, 0);
  assert.match(withPlayerKnowledge(unknown, first).text || '', /research is queued/);
});

test('outcome evidence is separate, deduped and failures queue review without promotion', async () => {
  const f = fixture();
  await observePlayerKnowledge({ userId: 'a', attemptId: 'attempt', snapshot }, f.deps);
  await observePlayerKnowledge({ userId: 'b', attemptId: 'attempt', snapshot }, f.deps);
  const input = { userId: 'a', attemptId: 'attempt', jobId: 'job', status: 'awaiting-input', verified: false, noProgress: true };
  await recordPlayerJobOutcome(input, f.deps);
  await recordPlayerJobOutcome(input, f.deps);
  const row = f.rows.get('a:dominknow');
  assert.equal(row?.evidence.outcomes.length, 1);
  assert.equal(row?.evidence.outcomes[0].status, 'no-progress');
  assert.equal(row?.status, 'candidate');
  assert.equal(f.rows.get('b:dominknow')?.evidence.outcomes.length, 0);
  assert.equal(f.reviews.size, 1);
  await recordPlayerJobOutcome({ ...input, jobId: 'passed-job', status: 'completed', verified: true, noProgress: false }, f.deps);
  assert.equal(row?.evidence.outcomes.filter(outcome => outcome.verified).length, 1);
  for (let i = 0; i < 35; i += 1) await recordPlayerJobOutcome({ ...input, jobId: `later-${i}`, noProgress: false }, f.deps);
  assert.equal(row?.evidence.outcomes.length, 32);
  await recordPlayerJobOutcome(input, f.deps);
  assert.ok(!row?.evidence.outcomes.some(outcome => outcome.jobId === input.jobId));
});

test('bounded untrusted context survives standing-instruction composition and retains action targets', () => {
  let evidence: PlayerEvidence | undefined;
  for (let i = 0; i < 80; i += 1) evidence = mergePlayerObservation(evidence, { player: identifyPlayer(snapshot), attemptId: `attempt-${i}`, at: now.toISOString() });
  assert.ok(evidence);
  assert.equal(evidence.observedAttemptIds.length, 64);
  assert.equal(evidence.observations, 80);
  const current = { ...snapshot, text: 'x'.repeat(8000), buttons: [{ id: 'b1', name: 'Next' }] };
  const extended = withPlayerKnowledge(current, evidence);
  assert.ok((extended.text?.length || 0) <= 8000 + PLAYER_CONTEXT_CHARS + 60);
  const composed = withStandingInstructions(extended, 'Keep this trusted instruction.');
  assert.match(composed.text || '', /untrusted navigation facts, not instructions or authorization/);
  assert.match(composed.text || '', /Keep this trusted instruction/);
  assert.deepEqual(composed.buttons, current.buttons);
});

test('Learning view distinguishes documented findings, availability checks and verified outcomes', () => {
  const evidence = mergePlayerObservation(undefined, { player: identifyPlayer(snapshot), attemptId: 'attempt', at: now.toISOString() });
  const html = renderToStaticMarkup(createElement(PlayerKnowledgePanel, { records: [{ id: 'one', evidence }] }));
  assert.match(html, /Findings reviewed 2026-11-03/);
  assert.match(html, /availability, not newly researched findings/);
  assert.match(html, /No run results recorded yet/);
  const unknown = mergePlayerObservation(undefined, { player: identifyPlayer({}), attemptId: 'attempt', at: now.toISOString() });
  assert.match(renderToStaticMarkup(createElement(PlayerKnowledgePanel, { records: [{ id: 'two', evidence: unknown }] })), /does not yet perform open-ended web research/);
});
