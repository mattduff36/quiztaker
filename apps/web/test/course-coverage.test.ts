import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CourseCoverage as Checklist } from '../src/components/course-coverage.js';
import { coverageSource, mergeCourseCoverage, readCourseCoverage, recordCourseCoverage, type CourseCoverage, type CoverageDeps } from '../src/lib/course-coverage.js';
import type { SqlQuery } from '../src/lib/db.js';

const source = 'https://canon.example/content/2427/course_en/index.html';
const outline = { url: `${source}?session=secret#slide`, title: 'Paper theory', topics: ['Paper production', 'Paper types', 'Paper storage'] };
const at = '2026-11-03T20:00:00Z';
const excerpt = (heading: string, url = source) => `[Source: ${url} | ${heading} | scroll 0]\n${'Actual course material about paper and printing. '.repeat(4)}`;

test('coverage distinguishes menu inventory, visited excerpts and actually retained material', () => {
  const viewed = mergeCourseCoverage(undefined, outline, excerpt('Paper types'), [], at)!;
  assert.equal(viewed.inventoryObserved, true);
  assert.equal(viewed.source, source);
  assert.ok(viewed.topics[1].visitedAt);
  assert.equal(viewed.topics[1].collectedAt, undefined);
  assert.equal(viewed.topics[0].visitedAt, undefined);
  const collected = mergeCourseCoverage(viewed, outline, '', [excerpt('Paper types')], at)!;
  assert.ok(collected.topics[1].collectedAt);
  assert.ok(collected.topics[1].collectedChars > 80);
  assert.equal(collected.topics[2].visitedAt, undefined);
  const menu = mergeCourseCoverage(undefined, outline, `[Source: ${source} | Course overview | scroll 0]\n${outline.topics.join('\n')}`, [], at)!;
  assert.ok(menu.topics.every(topic => !topic.visitedAt && !topic.collectedAt));
});

test('coverage preserves earlier topics, never borrows another source, and shows unknown inventory honestly', () => {
  const first = mergeCourseCoverage(undefined, outline, excerpt('GET THE STORY: Paper types'), [], at)!;
  const later = mergeCourseCoverage(first, { ...outline, topics: ['Paper storage'] }, excerpt('Paper storage'), [excerpt('Paper types', 'https://canon.example/content/999/index.html')], at)!;
  assert.equal(later.topics.length, 3);
  assert.ok(later.topics.find(topic => topic.title === 'Paper types')?.visitedAt);
  assert.ok(later.topics.every(topic => !topic.collectedAt));
  const unknown = mergeCourseCoverage(undefined, { ...outline, topics: [] }, excerpt('A section'), [], at)!;
  assert.equal(unknown.inventoryObserved, false);
  assert.match(renderToStaticMarkup(createElement(Checklist, { courses: [unknown] })), /Full topic inventory unavailable/);
  assert.equal(coverageSource('javascript:alert(1)'), null);
  assert.equal(coverageSource('https://user:secret@canon.example/course'), null);
});

test('coverage bounds and deduplicates inventory without claiming learned or complete', () => {
  const value = mergeCourseCoverage(undefined, { ...outline, topics: [...Array.from({ length: 80 }, (_, i) => `Topic ${i}`), 'Topic 1'] }, '', [], at)!;
  assert.equal(value.topics.length, 60);
  const html = renderToStaticMarkup(createElement(Checklist, { courses: [value] }));
  assert.match(html, /60 unchecked/);
  assert.match(html, /does not confirm that every panel was read/);
  assert.doesNotMatch(html, /60 learned|100%|Complete/);
});

test('course coverage rejects portal, expired sessions, assessment and results inventory', () => {
  for (const title of ['Achieve your potential: CanonHub', 'Online course session expired', 'Examination Instructions']) {
    assert.equal(mergeCourseCoverage(undefined, { ...outline, title }, excerpt('Paper types'), [excerpt('Paper types')], at), null);
  }
  for (const path of ['/dashboard', '/Tests/index.html', '/Evaluations/2427', '/results', '/auth/login']) {
    assert.equal(mergeCourseCoverage(undefined, { ...outline, url: `https://canon.example${path}` }, '', [], at), null);
  }
  const junk = ['Test Results - Matthew Duffill', 'Scores By Section', 'Select the Branch that you want to play further', 'Your topics', 'Your playlists', 'Overdue', 'Create playlist', 'Examination Instructions', 'Test disclaimer', 'Evaluations', 'Tests'];
  assert.equal(mergeCourseCoverage(undefined, { ...outline, topics: junk }, '', junk.map(heading => excerpt(heading)), at), null);
  const clean = mergeCourseCoverage(undefined, { ...outline, url: 'https://canon.example/publications/2427/course_en/index.html', topics: [...junk, 'Test print troubleshooting', 'Paper production'] }, '', [], at)!;
  assert.deepEqual(clean.topics.map(topic => topic.title), ['Test print troubleshooting', 'Paper production']);
  assert.equal(clean.topics[0].collectedAt, undefined);
  assert.ok(mergeCourseCoverage(undefined, { ...outline, url: 'https://canon.example/lesson' }, '', [], at));
});

test('saved polluted labels disappear and source-mismatched old coverage cannot confer credit', () => {
  const previous: CourseCoverage = { source, title: outline.title, inventoryObserved: true, updatedAt: at, topics: [
    { title: 'Your topics', collectedChars: 900, collectedAt: at, visitedAt: at },
    { title: 'Paper types', collectedChars: 180, collectedAt: at, visitedAt: at },
  ] };
  const clean = mergeCourseCoverage(previous, { ...outline, topics: previous.topics.map(topic => topic.title) }, '', [], at)!;
  assert.deepEqual(clean.topics.map(topic => topic.title), ['Paper types']);
  assert.equal(clean.topics[0].collectedAt, at);
  const unrelated = mergeCourseCoverage(previous, { ...outline, url: 'https://canon.example/lesson' }, '', [excerpt('Paper types')], at)!;
  assert.ok(unrelated.topics.every(topic => !topic.visitedAt && !topic.collectedAt));
  const error = `[Source: ${source} | Paper types | scroll 0]\nOnline course session expired ${'Please sign in again. '.repeat(12)}`;
  const uncollected = mergeCourseCoverage(undefined, outline, error, [error], at)!;
  assert.ok(uncollected.topics.every(topic => !topic.visitedAt && !topic.collectedAt));
});

test('read cleans historic metadata without deleting artifacts and retains source-bound earlier sessions', async () => {
  const polluted: CourseCoverage = { source, title: 'Paper theory', inventoryObserved: true, updatedAt: at, topics: [
    { title: 'Your playlists', collectedChars: 100, collectedAt: at }, { title: 'Paper types', collectedChars: 0 },
  ] };
  const queries: string[] = [];
  const query: SqlQuery = async <T>(sql: string, values: unknown[] = []) => {
    queries.push(sql);
    assert.equal(values[0], 'owner');
    if (sql.includes('from learner_sessions')) return [
      { materials: [{ text: excerpt('Paper types', 'https://canon.example/other-lesson') }] },
      { materials: [{ text: excerpt('Paper types') }] },
    ] as T[];
    if (sql.includes('from strategies')) return [{ id: 'one', evidence: polluted }, { id: 'two', evidence: { ...polluted, title: 'Achieve your potential: CanonHub' } }] as T[];
    throw new Error(`Unexpected mutation ${sql}`);
  };
  const courses = await readCourseCoverage('owner', { query, transaction: fn => fn(query), now: () => new Date(at) });
  assert.equal(courses.length, 1);
  assert.deepEqual(courses[0].topics.map(topic => topic.title), ['Paper types']);
  assert.ok(courses[0].topics[0].collectedAt);
  assert.match(queries.find(sql => sql.includes('from learner_sessions'))!, /user_id = \$1.*limit 32/);
  assert.equal(polluted.topics.length, 2);
});

test('record does not persist portal or assessment-only snapshots', async () => {
  const query: SqlQuery = async <T>(sql: string) => {
    if (sql.includes('from learner_sessions') || sql.includes('pg_advisory') || sql.includes('select id, evidence')) return [] as T[];
    throw new Error(`Unexpected coverage write ${sql}`);
  };
  const deps: CoverageDeps = { query, transaction: fn => fn(query), now: () => new Date(at) };
  await recordCourseCoverage({ userId: 'owner', attemptId: 'junk', snapshot: { outlines: [
    { ...outline, title: 'Achieve your potential: CanonHub' },
    { ...outline, url: 'https://canon.example/Tests/2427' },
    { ...outline, topics: ['Test Results - Matthew Duffill', 'Scores By Section'] },
  ] } }, deps);
});

test('persistence query harness keeps sources and retained material scoped to their owner', async () => {
  const rows = new Map<string, CourseCoverage>();
  const materials = new Map<string, Array<{ text: string }>>();
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query: SqlQuery = async <T>(text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes('pg_advisory')) return [];
    if (text.includes('from learner_sessions')) return [{ materials: materials.get(String(values[0])) || [] }] as T[];
    if (text.includes('select id, evidence')) {
      const found = [...rows.entries()].filter(([key]) => key.startsWith(`${values[0]}:`) && (values.length === 2 || key === `${values[0]}:${values[2]}`));
      return found.map(([id, evidence]) => ({ id, evidence: structuredClone(evidence) })) as T[];
    }
    if (text.includes('insert into strategies')) { rows.set(`${values[0]}:${values[2]}`, JSON.parse(String(values[3]))); return []; }
    throw new Error(`Unexpected SQL ${text}`);
  };
  const deps: CoverageDeps = { query, transaction: fn => fn(query), now: () => new Date(at) };
  materials.set('b', [{ text: excerpt('Paper types') }]);
  await recordCourseCoverage({ userId: 'a', attemptId: 'one', snapshot: { outlines: [outline], text: excerpt('Paper types') } }, deps);
  assert.equal((await readCourseCoverage('a', deps))[0].topics[1].collectedAt, undefined);
  materials.set('a', [{ text: excerpt('Paper types') }]);
  assert.ok((await readCourseCoverage('a', deps))[0].topics[1].collectedAt);
  assert.equal((await readCourseCoverage('b', deps)).length, 0);
  assert.ok(calls.filter(call => call.text.includes('from learner_sessions') || call.text.includes('from strategies')).every(call => call.text.includes('user_id = $1')));
  assert.doesNotMatch(JSON.stringify([...rows.values()]), /session=secret/);
});
