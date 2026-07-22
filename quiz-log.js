/**
 * Per-attempt answer log + cumulative history.
 *
 * Layout:
 *   data/runs/<attemptId>/answers.jsonl  - one line per question
 *   data/runs/<attemptId>/meta.json      - attempt metadata (startedAt, score, pass/fail)
 *   data/runs/<attemptId>/q<NN>.png      - screenshot for that question (optional)
 *   data/runs/history.json               - cumulative per-stem record across attempts
 *   data/runs/index.json                 - list of all attempts with scores
 *
 * All paths derived from this file's __dirname so the helpers work regardless of cwd.
 */
const fs = require('fs');
const path = require('path');
const {
  createAttempt: createLedgerAttempt,
  finishAttempt: finishLedgerAttempt,
  recordStep,
} = require('./lib/attempt-ledger');
const { observeOutcome } = require('./lib/learning-engine');
const { APP_ROOT, dataPath } = require('./lib/paths');

const ROOT = dataPath('runs');
const HISTORY_PATH = path.join(ROOT, 'history.json');
const INDEX_PATH = path.join(ROOT, 'index.json');
const CURRENT_PATH = path.join(ROOT, 'current-attempt.txt');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function newAttemptId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function startAttempt(note = '') {
  ensureDir(ROOT);
  const id = newAttemptId();
  const dir = path.join(ROOT, id);
  ensureDir(dir);
  const ledgerAttemptId = createLedgerAttempt({
    source: 'quiz-workflow',
    capabilityId: 'server-assessment',
    capabilityVersion: 1,
    fingerprint: 'server-assessment',
    target: note || id,
    risk: 'high',
  });
  const meta = { attemptId: id, ledgerAttemptId, startedAt: new Date().toISOString(), note, score: null, pass: null, finishedAt: null };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(CURRENT_PATH, id);
  appendIndex({ attemptId: id, startedAt: meta.startedAt, note, score: null, pass: null });
  return id;
}

function currentAttemptId() {
  if (!fs.existsSync(CURRENT_PATH)) return null;
  const id = fs.readFileSync(CURRENT_PATH, 'utf8').trim();
  return id || null;
}

function attemptDir(attemptId) {
  if (!attemptId) throw new Error('attemptId required');
  const dir = path.join(ROOT, attemptId);
  ensureDir(dir);
  return dir;
}

function normalizeStemKey(stem) {
  return String(stem || '')
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function appendAnswer(attemptId, entry) {
  const dir = attemptDir(attemptId);
  const row = {
    ...entry,
    stemKey: normalizeStemKey(entry.stem || ''),
    loggedAt: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(dir, 'answers.jsonl'), `${JSON.stringify(row)}\n`);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (meta.ledgerAttemptId) {
      recordStep(meta.ledgerAttemptId, 'answer-recorded', {
        qNum: row.qNum ?? null,
        stemKey: row.stemKey,
        confidence: row.confidence || null,
      });
    }
  } catch {}
  return row;
}

function readAnswers(attemptId) {
  const p = path.join(attemptDir(attemptId), 'answers.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function finishAttempt(attemptId, { score, pass, note } = {}) {
  const dir = attemptDir(attemptId);
  const metaPath = path.join(dir, 'meta.json');
  let meta = { attemptId };
  if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.score = score ?? meta.score ?? null;
  meta.pass = pass ?? meta.pass ?? null;
  meta.finishedAt = new Date().toISOString();
  if (note) meta.note = note;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  updateIndex(attemptId, { score: meta.score, pass: meta.pass, finishedAt: meta.finishedAt });
  updateHistoryFromAttempt(attemptId);
  if (meta.ledgerAttemptId) {
    const passed = meta.pass === true;
    finishLedgerAttempt(meta.ledgerAttemptId, passed ? 'success' : 'failure', {
      verified: typeof meta.score === 'number',
      status: typeof meta.score === 'number' ? `score ${meta.score}` : 'score unknown',
      failureSignature: passed ? null : 'assessment-below-pass-score',
      artifacts: [path.relative(APP_ROOT, dir).replace(/\\/g, '/')],
    });
    observeOutcome({
      attemptId: meta.ledgerAttemptId,
      capabilityId: 'server-assessment',
      capabilityVersion: 1,
      fingerprint: 'server-assessment',
      targetId: meta.note || attemptId,
      actions: ['probe', 'answer-select', 'verify'],
      outcome: passed ? 'success' : 'failure',
      verified: typeof meta.score === 'number',
      failureSignature: passed ? null : 'assessment-below-pass-score',
    });
  }
  return meta;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveIndex(rows) {
  ensureDir(ROOT);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(rows, null, 2));
}

function appendIndex(row) {
  const rows = loadIndex();
  rows.push(row);
  saveIndex(rows);
}

function updateIndex(attemptId, patch) {
  const rows = loadIndex();
  const idx = rows.findIndex((r) => r.attemptId === attemptId);
  if (idx === -1) return;
  rows[idx] = { ...rows[idx], ...patch };
  saveIndex(rows);
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return { version: 1, stems: {} };
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return { version: 1, stems: {} };
  }
}

function saveHistory(hist) {
  ensureDir(ROOT);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist, null, 2));
}

function updateHistoryFromAttempt(attemptId) {
  const dir = attemptDir(attemptId);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const answers = readAnswers(attemptId);
  if (!answers.length) return;

  const hist = loadHistory();
  const score = typeof meta.score === 'number' ? meta.score : null;

  for (const a of answers) {
    const key = a.stemKey || normalizeStemKey(a.stem || '');
    if (!key) continue;
    if (!hist.stems[key]) {
      hist.stems[key] = {
        stemKey: key,
        stemSamples: [],
        allOptions: [],
        picks: [],
      };
    }
    const entry = hist.stems[key];
    if (a.stem && !entry.stemSamples.includes(a.stem)) entry.stemSamples.push(a.stem);
    for (const opt of a.options || []) {
      if (!entry.allOptions.includes(opt)) entry.allOptions.push(opt);
    }
    entry.picks.push({
      attemptId,
      qNum: a.qNum ?? null,
      picks: a.picks || [],
      confidence: a.confidence || null,
      reasoning: a.reasoning || '',
      attemptScore: score,
      attemptPass: meta.pass === true,
      loggedAt: a.loggedAt,
    });
  }
  hist.updatedAt = new Date().toISOString();
  saveHistory(hist);
}

function findPriorPicks(stem) {
  const hist = loadHistory();
  const key = normalizeStemKey(stem);
  if (!key) return [];
  const entry = hist.stems[key];
  if (!entry) return [];
  return entry.picks.slice().reverse();
}

module.exports = {
  ROOT,
  appendAnswer,
  attemptDir,
  currentAttemptId,
  finishAttempt,
  findPriorPicks,
  loadHistory,
  loadIndex,
  normalizeStemKey,
  readAnswers,
  startAttempt,
};
