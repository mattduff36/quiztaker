#!/usr/bin/env node
// migrate-learning-data.js
//
// Idempotently backfills legacy completion/quiz logs into the attempt ledger,
// indexes existing learn captures, seeds documented registry evidence, and
// preserves the currently unclosed session as a migration recap.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { appendEvent, readAttempts } = require('./lib/attempt-ledger');
const { CAPABILITIES } = require('./lib/capabilities');
const { classifyUrl, fingerprintFor } = require('./lib/page-probe');
const {
  observeOutcome,
  queueReview,
  readStrategies,
  syncQuizTypesEvidence,
} = require('./lib/learning-engine');
const { buildSessionReport } = require('./lib/session-report');

const ROOT = __dirname;
const HISTORY_DIR = path.join(ROOT, 'data', 'course-history');
const LEARN_DIR = path.join(ROOT, 'data', 'learn');
const ATTEMPT_DIR = path.join(ROOT, 'data', 'attempts');
const MARKER_FILE = path.join(ATTEMPT_DIR, 'migration-v1.json');

function readJsonl(file) {
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

function stableId(source, index, row) {
  const hash = createHash('sha256')
    .update(`${source}:${index}:${JSON.stringify(row)}`)
    .digest('hex')
    .slice(0, 24);
  return `legacy-${hash}`;
}

function normalizedLegacyRows() {
  const rows = [];
  for (const [file, capabilityId, titleKey] of [
    ['certifications.jsonl', 'cert-batch', 'cert'],
    ['batch.jsonl', 'cert-batch', 'course'],
    ['container.jsonl', 'container-batch', 'title'],
    ['log.jsonl', 'scorm-complete', 'label'],
  ]) {
    readJsonl(path.join(HISTORY_DIR, file)).forEach((row, index) => {
      if (file !== 'certifications.jsonl' && !['verify', 'result'].includes(row.event || 'result')) return;
      const resultStatus = row.result?.after?.lesson_status || row.result?.after?.success || '';
      const status = row.status || resultStatus || (typeof row.result === 'string' ? row.result : '');
      const verified = row.ok === true || /Successful|Completed|passed|acquired/i.test(String(status));
      rows.push({
        source: file,
        index,
        row,
        capabilityId,
        capabilityVersion: CAPABILITIES.find((item) => item.id === capabilityId)?.version || 1,
        targetId: row[titleKey] || row.title || row.course || `${file}-${index}`,
        ts: row.ts || new Date().toISOString(),
        outcome: verified ? 'success' : 'failure',
        verified,
        status: String(status || (verified ? 'legacy-verified' : 'legacy-unconfirmed')),
      });
    });
  }

  let quizIndex = [];
  try { quizIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runs', 'index.json'), 'utf8')); } catch {}
  if (!Array.isArray(quizIndex)) quizIndex = quizIndex?.attempts || [];
  quizIndex.forEach((row, index) => {
    const verified = typeof row.pass === 'boolean' || typeof row.score === 'number';
    rows.push({
      source: 'quiz-index',
      index,
      row,
      capabilityId: 'server-assessment',
      capabilityVersion: 1,
      targetId: row.title || row.note || row.attemptId,
      ts: row.finishedAt || row.startedAt || new Date().toISOString(),
      outcome: row.pass === true ? 'success' : 'failure',
      verified,
      status: `score ${row.score ?? 'unknown'}`,
    });
  });
  return rows;
}

function migrateLegacyAttempts() {
  const existing = new Set(readAttempts().map((attempt) => attempt.attemptId));
  let migrated = 0;
  for (const item of normalizedLegacyRows()) {
    const attemptId = stableId(item.source, item.index, item.row);
    if (existing.has(attemptId)) continue;
    const at = new Date(item.ts);
    const safeAt = Number.isFinite(at.getTime()) ? at : new Date();
    appendEvent(attemptId, 'attempt-created', {
      source: `legacy:${item.source}`,
      capabilityId: item.capabilityId,
      capabilityVersion: item.capabilityVersion,
      fingerprint: `legacy-${item.capabilityId}`,
      target: item.targetId,
      planId: null,
      risk: 'legacy',
    }, safeAt);
    appendEvent(attemptId, 'attempt-finished', {
      outcome: item.outcome,
      verified: item.verified,
      status: item.status,
      failureSignature: item.outcome === 'failure' ? 'legacy-unconfirmed' : null,
      artifacts: [],
      exitCode: null,
    }, new Date(safeAt.getTime() + 1));
    observeOutcome({
      ts: safeAt.toISOString(),
      attemptId,
      capabilityId: item.capabilityId,
      capabilityVersion: item.capabilityVersion,
      fingerprint: `legacy-${item.capabilityId}`,
      targetId: item.targetId,
      actions: ['probe', 'verify'],
      outcome: item.outcome,
      verified: item.verified,
      failureSignature: item.outcome === 'failure' ? 'legacy-unconfirmed' : null,
    });
    migrated += 1;
  }
  return migrated;
}

function indexLearnCaptures() {
  fs.mkdirSync(LEARN_DIR, { recursive: true });
  const indexFile = path.join(LEARN_DIR, 'index.jsonl');
  const indexed = new Set(readJsonl(indexFile).map((row) => row.dir));
  let indexedCount = 0;
  for (const entry of fs.readdirSync(LEARN_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(LEARN_DIR, entry.name);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    let meta;
    let oldProbe = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { continue; }
    try { oldProbe = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8')); } catch {}
    const relativeDir = path.relative(ROOT, dir).replace(/\\/g, '/');
    const normalizedFile = path.join(dir, 'normalized-probe.json');
    let normalized;
    try { normalized = JSON.parse(fs.readFileSync(normalizedFile, 'utf8')); } catch {
      normalized = {
        schemaVersion: 1,
        capturedAt: meta.capturedAt,
        tabIdx: meta.tabIdx,
        title: meta.title,
        url: meta.url,
        urlKind: classifyUrl(meta.url),
        host: (() => { try { return new URL(meta.url).host; } catch { return ''; } })(),
        path: (() => { try { return new URL(meta.url).pathname; } catch { return ''; } })(),
        scorm: null,
        hasSlickQuiz: false,
        hasAssessmentShell: false,
        hasActivityRows: false,
        hasDocumentContent: false,
        inputKinds: [],
        buttons: oldProbe.buttons || [],
        frames: oldProbe.frames || [],
      };
      normalized.fingerprint = fingerprintFor(normalized);
      fs.writeFileSync(normalizedFile, JSON.stringify(normalized, null, 2));
    }
    const wasIndexed = indexed.has(relativeDir);
    if (!wasIndexed) {
      fs.appendFileSync(indexFile, `${JSON.stringify({
        schemaVersion: 2,
        capturedAt: meta.capturedAt,
        tabIdx: meta.tabIdx,
        title: meta.title,
        url: meta.url,
        detected: meta.detected || normalized.urlKind,
        fingerprint: meta.fingerprint || normalized.fingerprint,
        attemptId: meta.attemptId || null,
        dir: relativeDir,
      })}\n`);
      indexedCount += 1;
      if (['other', 'content-player'].includes(normalized.urlKind)) {
        queueReview({
          id: `migrated-capture-${createHash('sha256').update(relativeDir).digest('hex').slice(0, 16)}`,
          type: 'migrated-capture',
          title: `Review migrated capture: ${meta.title || entry.name}`,
          fingerprint: normalized.fingerprint,
          artifact: relativeDir,
          detail: meta.url || '',
          nextAction: 'Replay the normalized probe and compare it with current candidates.',
        });
      }
    }
  }
  return indexedCount;
}

function resolveDuplicateMigratedReviews() {
  const reviewFile = path.join(ROOT, 'data', 'knowledge', 'review-queue.jsonl');
  const byId = new Map();
  for (const row of readJsonl(reviewFile)) {
    const previous = byId.get(row.id) || {};
    byId.set(row.id, { ...previous, ...row });
  }
  const reviews = [...byId.values()].filter((row) => row.type === 'migrated-capture' && row.status === 'open');
  const seen = new Set();
  let resolved = 0;
  for (const review of reviews) {
    const key = review.artifact || `${review.fingerprint}:${review.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    fs.appendFileSync(reviewFile, `${JSON.stringify({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      id: review.id,
      status: 'resolved',
      resolution: 'Duplicate migration review.',
    })}\n`);
    resolved += 1;
  }
  return resolved;
}

function reconcileRegressionStatuses() {
  const reviewFile = path.join(ROOT, 'data', 'knowledge', 'review-queue.jsonl');
  const latest = new Map();
  for (const row of readJsonl(reviewFile)) {
    const previous = latest.get(row.id) || {};
    latest.set(row.id, { ...previous, ...row });
  }
  const regressions = [...latest.values()].filter((row) => row.type === 'strategy-regression' && row.status === 'open');
  const store = readStrategies();
  let changed = 0;
  for (const review of regressions) {
    const strategy = Object.values(store.strategies).find((candidate) => (
      (review.strategyKey && candidate.key === review.strategyKey) ||
      (candidate.fingerprint === review.fingerprint && review.title?.includes(candidate.capabilityId))
    ));
    if (strategy && strategy.status !== 'needs-review') {
      strategy.status = 'needs-review';
      strategy.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  if (changed) {
    fs.writeFileSync(path.join(ROOT, 'data', 'knowledge', 'strategies.json'), JSON.stringify(store, null, 2));
    syncQuizTypesEvidence(store);
  }
  return changed;
}

function seedDocumentedEvidence() {
  const file = path.join(ROOT, 'data', 'knowledge', 'seed-evidence.json');
  const seed = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'docs/QUIZ-TYPES.md',
    capabilities: CAPABILITIES
      .filter((capability) => capability.mutatesCourse || capability.id === 'learn-capture')
      .map((capability) => ({
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        verifier: capability.verifier,
        risk: capability.risk,
        evidenceStatus: 'documented-seed',
      })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function preserveUnclosedSession() {
  const report = buildSessionReport();
  if (!report.counts.total) return null;
  const file = path.join(ROOT, 'data', 'sessions', 'migrated-unclosed-2026-07-20.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...report, migration: true }, null, 2));
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function main() {
  fs.mkdirSync(ATTEMPT_DIR, { recursive: true });
  const summary = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    legacyAttemptsAdded: migrateLegacyAttempts(),
    learnCapturesIndexed: indexLearnCaptures(),
    duplicateReviewsResolved: resolveDuplicateMigratedReviews(),
    regressionStatusesReconciled: reconcileRegressionStatuses(),
    evidenceSeed: seedDocumentedEvidence(),
    unclosedSessionRecap: preserveUnclosedSession(),
  };
  fs.writeFileSync(MARKER_FILE, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
