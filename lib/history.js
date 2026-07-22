// lib/history.js
//
// Merges the several per-run JSONL logs the automation writes into a single,
// normalized, time-sorted list the dashboard History page can render.
//
// Sources (all under data/course-history/):
//   certifications.jsonl  curated, cert-level rows (hand/agent-appended)
//   batch.jsonl           pw-cert-batch.js events (we use event:"verify")
//   log.jsonl             pw-scorm-complete.js single-course completions
//   container.jsonl       pw-container-batch.js events (event:"verify")
//
// Every row is normalized to:
//   { ts, kind: 'cert'|'course'|'activity', title, result, detail, source }

const fs = require('fs');
const path = require('path');
const { readAttempts } = require('./attempt-ledger');
const { dataPath } = require('./paths');

const HIST_DIR = dataPath('course-history');

function readJsonl(file) {
  try {
    const data = fs.readFileSync(path.join(HIST_DIR, file), 'utf8');
    return data.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// certifications.jsonl -> one 'cert' row each.
function fromCertifications() {
  return readJsonl('certifications.jsonl').map((r) => ({
    ts: r.ts || '',
    kind: 'cert',
    title: r.cert || r.certId || '(certification)',
    result: r.result || (r.score ? `score ${r.score}` : ''),
    detail: [r.strategy, r.notes].filter(Boolean).join(' — '),
    source: 'certifications',
  }));
}

// batch.jsonl -> one 'course' row per verify event.
function fromBatch() {
  return readJsonl('batch.jsonl')
    .filter((e) => e.event === 'verify' && e.course)
    .map((e) => ({
      ts: e.ts || '',
      kind: 'course',
      title: e.course,
      result: e.ok ? 'passed' : (e.status || 'needs review'),
      detail: e.how ? `via ${e.how}${e.status ? ` (roster: ${e.status})` : ''}` : '',
      source: 'batch',
    }));
}

// log.jsonl -> one 'course' row per scorm-complete entry.
function fromScormLog() {
  return readJsonl('log.jsonl')
    .filter((e) => e.label)
    .map((e) => {
      const after = (e.result && e.result.after) || {};
      const status = after.lesson_status || after.completion || after.success || (e.status_set || '');
      return {
        ts: e.ts || '',
        kind: 'course',
        title: e.label,
        result: status || 'unknown',
        detail: [e.strategy, e.score_set != null ? `score ${e.score_set}` : '']
          .filter(Boolean).join(' — '),
        source: 'scorm',
      };
    });
}

// container.jsonl -> one 'activity' row per verify event.
function fromContainer() {
  return readJsonl('container.jsonl')
    .filter((e) => e.event === 'verify' && e.title)
    .map((e) => ({
      ts: e.ts || '',
      kind: 'activity',
      title: e.title,
      result: e.ok ? 'passed' : (e.status || 'needs review'),
      detail: e.result && e.result.err ? `error: ${e.result.err}` : '',
      source: 'container',
    }));
}

function fromAttemptLedger() {
  return readAttempts()
    .filter((attempt) => attempt.finishedAt)
    .map((attempt) => ({
      ts: attempt.finishedAt || attempt.createdAt || '',
      kind: 'attempt',
      title: attempt.capabilityId || '(automation attempt)',
      result: attempt.verified ? `${attempt.outcome} (verified)` : attempt.outcome || 'unknown',
      detail: [
        attempt.status,
        attempt.fingerprint ? `fingerprint ${attempt.fingerprint}` : '',
        attempt.diagnosis?.likelyCause?.label || (attempt.failureSignature ? `failure ${attempt.failureSignature}` : ''),
      ].filter(Boolean).join(' — '),
      source: 'attempt-ledger',
    }));
}

function fromSessionHistory() {
  try {
    const file = dataPath('sessions', 'history.jsonl');
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .map((row) => ({
        ts: row.ts || '',
        kind: 'session',
        title: row.title || 'Session summary',
        result: row.result || '',
        detail: [row.strategy, row.notes].filter(Boolean).join(' — '),
        source: 'sessions',
      }));
  } catch {
    return [];
  }
}

// Merge everything and sort newest-first. `ts` values are a mix of date-only
// (certifications) and full ISO timestamps; string compare orders them well
// enough for display, but we fall back gracefully for empties.
function readMerged() {
  const rows = [
    ...fromCertifications(),
    ...fromBatch(),
    ...fromScormLog(),
    ...fromContainer(),
    ...fromAttemptLedger(),
    ...fromSessionHistory(),
  ];
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows;
}

module.exports = { readMerged, readJsonl, HIST_DIR };
