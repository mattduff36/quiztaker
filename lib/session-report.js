// lib/session-report.js
//
// Aggregates the per-run JSONL logs written during a dashboard "session" into a
// single report, and (optionally) commits that report as durable artifacts:
//   - a machine-readable recap:      data/sessions/<ISO>.json
//   - a human "fold this into docs":  data/sessions/needs-review.md (appended)
//   - a curated history row:          data/course-history/certifications.jsonl
//   - a session marker:               data/sessions/.last-end
//
// A "session" is the window since the last End-session marker (or the last 12h
// if there is no marker yet). The marker file survives `node --watch` restarts,
// so ending a session is stable regardless of how many times the server bounced.

const fs = require('fs');
const path = require('path');
const { readJsonl } = require('./history');
const { readAttempts } = require('./attempt-ledger');
const { USER_HOME, dataPath } = require('./paths');

const SESS_DIR = dataPath('sessions');
const MARKER = path.join(SESS_DIR, '.last-end');
const NEEDS_REVIEW = path.join(SESS_DIR, 'needs-review.md');
const SESSION_HISTORY = path.join(SESS_DIR, 'history.jsonl');

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000;

function readMarker() {
  try { return fs.readFileSync(MARKER, 'utf8').trim() || null; }
  catch { return null; }
}

function inWindow(ts, startMs, endMs) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return t > startMs && t <= endMs;
}

function readFileJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Classify a verify/attempt result into an anomaly note, or null if clean.
function anomalyFor(item) {
  const err = item.err;
  if (err === 'no-api') return 'no SCORM API found (likely a non-SCORM external tool — needs manual completion)';
  if (err) return `error: ${err}`;
  if (item.ok === false) {
    if (!item.status || /unknown/i.test(item.status)) return 'completion not confirmed in the roster';
    return `left in status "${item.status}"`;
  }
  return null;
}

// Build the report for the current session window (no writes).
function buildSessionReport(now = new Date()) {
  const endMs = now.getTime();
  const marker = readMarker();
  const startMs = marker ? Date.parse(marker) : endMs - DEFAULT_WINDOW_MS;

  const items = [];
  const anomalies = [];

  // pw-cert-batch.js -> course verify events
  for (const e of readJsonl('batch.jsonl')) {
    if (e.event !== 'verify' || !e.course || !inWindow(e.ts, startMs, endMs)) continue;
    const it = { ts: e.ts, kind: 'course', title: e.course, ok: !!e.ok, status: e.status, how: e.how };
    items.push(it);
    const note = anomalyFor({ ok: e.ok, status: e.status, err: e.result && e.result.err });
    if (note) anomalies.push({ ts: e.ts, kind: 'course', title: e.course, issue: note });
  }
  for (const e of readJsonl('batch.jsonl')) {
    if (e.event !== 'skip' || !e.course || !inWindow(e.ts, startMs, endMs)) continue;
    const issue = e.reason || 'skipped';
    items.push({ ts: e.ts, kind: 'course', title: e.course, ok: false, status: issue, how: 'skip' });
    anomalies.push({ ts: e.ts, kind: 'course', title: e.course, issue });
  }

  // pw-scorm-complete.js -> single-course completions
  for (const e of readJsonl('log.jsonl')) {
    if (!e.label || !inWindow(e.ts, startMs, endMs)) continue;
    const after = (e.result && e.result.after) || {};
    const status = after.lesson_status || after.completion || after.success || e.status_set || '';
    const ok = /pass|complet/i.test(status);
    items.push({ ts: e.ts, kind: 'course', title: e.label, ok, status });
    if (!ok) anomalies.push({ ts: e.ts, kind: 'course', title: e.label, issue: `status "${status || 'unknown'}"` });
  }

  // pw-container-batch.js -> per-activity verify events
  for (const e of readJsonl('container.jsonl')) {
    if (e.event !== 'verify' || !e.title || !inWindow(e.ts, startMs, endMs)) continue;
    const it = { ts: e.ts, kind: 'activity', title: e.title, ok: !!e.ok, status: e.status };
    items.push(it);
    const note = anomalyFor({ ok: e.ok, status: e.status, err: e.result && e.result.err });
    if (note) anomalies.push({ ts: e.ts, kind: 'activity', title: e.title, issue: note });
  }

  for (const attempt of readAttempts()) {
    if (!attempt.finishedAt || !inWindow(attempt.finishedAt, startMs, endMs)) continue;
    const ok = attempt.outcome === 'success' && attempt.verified;
    items.push({
      ts: attempt.finishedAt,
      kind: 'attempt',
      title: attempt.capabilityId || attempt.attemptId,
      ok,
      status: attempt.status,
      attemptId: attempt.attemptId,
    });
    if (attempt.outcome === 'failure') {
      anomalies.push({
        ts: attempt.finishedAt,
        kind: 'attempt',
        title: attempt.capabilityId || attempt.attemptId,
        issue: attempt.diagnosis?.likelyCause?.label || attempt.failureSignature || attempt.status || 'failed attempt',
      });
    }
  }

  const learnIndex = dataPath('learn', 'index.jsonl');
  for (const capture of readFileJsonl(learnIndex)) {
    if (!inWindow(capture.capturedAt, startMs, endMs)) continue;
    items.push({
      ts: capture.capturedAt,
      kind: 'capture',
      title: capture.title || capture.detected || 'Learning capture',
      ok: true,
      status: capture.detected,
      artifact: capture.dir,
    });
  }

  try {
    const quizIndex = JSON.parse(fs.readFileSync(dataPath('runs', 'index.json'), 'utf8'));
    const attempts = Array.isArray(quizIndex) ? quizIndex : quizIndex.attempts || [];
    for (const quiz of attempts) {
      const ts = quiz.finishedAt || quiz.startedAt || quiz.ts;
      if (!ts || !inWindow(ts, startMs, endMs)) continue;
      const ok = quiz.pass === true || Number(quiz.score) >= Number(quiz.passScore || 80);
      items.push({ ts, kind: 'quiz-attempt', title: quiz.title || quiz.id || 'Quiz attempt', ok, status: quiz.score });
      if (!ok) anomalies.push({ ts, kind: 'quiz-attempt', title: quiz.title || quiz.id, issue: `score ${quiz.score ?? 'unknown'}` });
    }
  } catch {}

  items.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const coursesPassed = items.filter((i) => i.kind === 'course' && i.ok).length;
  const activitiesPassed = items.filter((i) => i.kind === 'activity' && i.ok).length;
  const attemptsRecorded = items.filter((i) => i.kind === 'attempt').length;
  const capturesRecorded = items.filter((i) => i.kind === 'capture').length;
  const quizAttempts = items.filter((i) => i.kind === 'quiz-attempt').length;
  const needsReview = items.filter((i) => !i.ok).length;

  return {
    window: { start: marker || new Date(startMs).toISOString(), end: now.toISOString(), hadMarker: !!marker },
    counts: { total: items.length, coursesPassed, activitiesPassed, attemptsRecorded, capturesRecorded, quizAttempts, needsReview },
    items,
    anomalies,
  };
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
}

// Write the durable artifacts and advance the session marker. Returns the paths
// written (relative to project root) for display.
function commitSession(report, now = new Date()) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const iso = now.toISOString();
  const safe = iso.replace(/[:.]/g, '-');
  const written = [];

  // 1. Machine-readable recap
  const recapFile = path.join(SESS_DIR, `${safe}.json`);
  fs.writeFileSync(recapFile, JSON.stringify(report, null, 2));
  written.push(path.relative(USER_HOME, recapFile).replace(/\\/g, '/'));

  // 2. Operational session history (kept separate from curated certifications)
  const c = report.counts;
  const sessionRow = {
    ts: iso,
    title: `Session summary — ${c.coursesPassed + c.activitiesPassed} item(s) completed`,
    result: `${c.coursesPassed} course(s), ${c.activitiesPassed} activit(y/ies) passed; ${c.needsReview} need review`,
    strategy: 'dashboard-session',
    notes: report.anomalies.length
      ? `needs review: ${report.anomalies.map((a) => a.title).join('; ')}`
      : 'clean session',
  };
  appendLine(SESSION_HISTORY, JSON.stringify(sessionRow) + '\n');
  written.push('data/sessions/history.jsonl');

  // 3. Needs-review note for the next agent to fold into docs/QUIZ-TYPES.md
  if (report.anomalies.length) {
    let md = `\n## Session ${iso}\n\n`;
    md += `Window: ${report.window.start} -> ${report.window.end}\n\n`;
    for (const a of report.anomalies) {
      md += `- [${a.kind}] **${a.title}** — ${a.issue}\n`;
    }
    appendLine(NEEDS_REVIEW, md);
    written.push('data/sessions/needs-review.md');
  }

  // 4. Advance the marker
  fs.writeFileSync(MARKER, iso);

  return written;
}

module.exports = { buildSessionReport, commitSession, SESS_DIR };
