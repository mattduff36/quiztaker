import { createHash } from 'node:crypto';
import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';

export const COURSE_COVERAGE_CAPABILITY = 'course-coverage';
export interface CoverageSnapshot { text?: string; outlines?: Array<{ url: string; title: string; topics: string[] }> }
export interface CoverageTopic { title: string; visitedAt?: string; collectedAt?: string; collectedChars: number }
export interface CourseCoverage { source: string; title: string; inventoryObserved: boolean; topics: CoverageTopic[]; updatedAt: string }
interface CoverageRow { id: string; evidence: CourseCoverage }
export interface CoverageDeps { query: SqlQuery; transaction: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>; now: () => Date }
const defaultDeps = (): CoverageDeps => ({ query: queryRows, transaction: withTransaction, now: () => new Date() });
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const bounded = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

export function coverageSource(raw: string): string | null {
  try { const url = new URL(raw); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? `${url.origin}${url.pathname}`.slice(0, 500) : null; } catch { return null; }
}
function topicMatches(heading: string, title: string): boolean {
  const a = normalize(heading), b = normalize(title);
  return a === b || (b.length >= 9 && a.endsWith(b)) || (a.length >= 9 && b.endsWith(a));
}
export function coverageSections(text: string): Array<{ source: string; heading: string; text: string }> {
  const result: Array<{ source: string; heading: string; text: string }> = [];
  const matches = [...text.matchAll(/\[Source: ([^\]\n]+?) \| ([^\]\n]*?) \| scroll [^\]\n]+\]/g)];
  for (let i = 0; i < matches.length && result.length < 16; i += 1) {
    const source = coverageSource(matches[i][1]);
    if (!source) continue;
    result.push({ source, heading: bounded(matches[i][2]), text: text.slice(matches[i].index! + matches[i][0].length, matches[i + 1]?.index ?? text.length).trim().slice(0, 8000) });
  }
  return result;
}

/** Inventory means observed menu/topic labels; an excerpt means some material, never complete learning. */
export function mergeCourseCoverage(previous: CourseCoverage | undefined, outline: { url: string; title: string; topics: string[] }, observedText: string, retainedTexts: string[], at: string): CourseCoverage | null {
  const source = coverageSource(outline.url);
  if (!source) return null;
  const inventory = [...new Map(outline.topics.slice(0, 60).map(title => [normalize(title), bounded(title)])).values()].filter(Boolean);
  const topics: CoverageTopic[] = (previous?.topics || []).map(topic => ({ ...topic }));
  for (const title of inventory) {
    const prior = topics.find(topic => topicMatches(topic.title, title));
    if (prior) prior.title = title;
    else if (topics.length < 60) topics.push({ title, collectedChars: 0 });
  }
  const observed = coverageSections(observedText).filter(section => section.source === source && section.text.length > 0);
  const collected = retainedTexts.flatMap(coverageSections).filter(section => section.source === source && section.text.length >= 80);
  if (!inventory.length && !previous?.inventoryObserved) for (const section of [...observed, ...collected]) {
    if (section.heading && !topics.some(topic => topicMatches(section.heading, topic.title)) && topics.length < 60) topics.push({ title: section.heading, collectedChars: 0 });
  }
  for (const topic of topics) {
    const visit = observed.find(section => topicMatches(section.heading, topic.title));
    const material = collected.filter(section => topicMatches(section.heading, topic.title)).sort((a, b) => b.text.length - a.text.length)[0];
    if (visit) topic.visitedAt ||= at;
    if (material) { topic.visitedAt ||= at; topic.collectedAt ||= at; }
    topic.collectedChars = Math.max(topic.collectedChars || 0, material?.text.length || 0);
  }
  return { source, title: bounded(outline.title) || previous?.title || 'Course material', inventoryObserved: inventory.length > 0 || previous?.inventoryObserved === true, topics: topics.slice(0, 60), updatedAt: at };
}

async function retainedCourseTexts(userId: string, query: SqlQuery): Promise<string[]> {
  const rows = await query<{ materials: Array<{ text?: string }> }>(`select materials from learner_sessions where user_id = $1 order by updated_at desc limit 1`, [userId]);
  return (rows[0]?.materials || []).slice(-64).map(item => String(item.text || '').slice(0, 8000));
}

export async function recordCourseCoverage(input: { userId: string; attemptId: string; snapshot: CoverageSnapshot }, deps = defaultDeps()): Promise<void> {
  const outlines = (input.snapshot.outlines || []).slice(0, 4);
  if (!outlines.length) return;
  const retained = await retainedCourseTexts(input.userId, deps.query);
  for (const outline of outlines) {
    const source = coverageSource(outline.url);
    if (!source) continue;
    const fingerprint = createHash('sha256').update(source).digest('hex').slice(0, 32);
    await deps.transaction(async query => {
      await query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`course-coverage:${input.userId}:${fingerprint}`]);
      const rows = await query<CoverageRow>(`select id, evidence from strategies where user_id = $1 and capability_id = $2 and capability_version = 1 and fingerprint = $3`, [input.userId, COURSE_COVERAGE_CAPABILITY, fingerprint]);
      const evidence = mergeCourseCoverage(rows[0]?.evidence, outline, input.snapshot.text || '', retained, deps.now().toISOString());
      if (!evidence) return;
      await query(`insert into strategies (user_id, capability_id, capability_version, fingerprint, status, evidence)
        values ($1, $2, 1, $3, 'candidate', $4::jsonb)
        on conflict (user_id, capability_id, capability_version, fingerprint)
        do update set evidence = excluded.evidence, revision = strategies.revision + 1, updated_at = now()`, [input.userId, COURSE_COVERAGE_CAPABILITY, fingerprint, JSON.stringify(evidence)]);
    });
  }
}

export async function readCourseCoverage(userId: string, deps = defaultDeps()): Promise<CourseCoverage[]> {
  const [rows, retained] = await Promise.all([
    deps.query<CoverageRow>(`select id, evidence from strategies where user_id = $1 and capability_id = $2 and capability_version = 1 order by updated_at desc limit 12`, [userId, COURSE_COVERAGE_CAPABILITY]),
    retainedCourseTexts(userId, deps.query),
  ]);
  return rows.map(row => mergeCourseCoverage(row.evidence, { url: row.evidence.source, title: row.evidence.title, topics: row.evidence.inventoryObserved ? row.evidence.topics.map(topic => topic.title) : [] }, '', retained, row.evidence.updatedAt)).filter((value): value is CourseCoverage => Boolean(value));
}
