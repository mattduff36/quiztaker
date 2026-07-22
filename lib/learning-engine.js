// lib/learning-engine.js
//
// Evidence-backed strategy statistics and automatic threshold promotion.
// Learned strategies are data only and may contain safe DSL actions; this
// module never writes or executes JavaScript.

const fs = require('fs');
const path = require('path');
const { SAFE_ACTIONS } = require('./capabilities');
const { APP_ROOT, dataPath } = require('./paths');

const KNOWLEDGE_DIR = process.env.SABA_KNOWLEDGE_DIR || dataPath('knowledge');
const STRATEGIES_FILE = path.join(KNOWLEDGE_DIR, 'strategies.json');
const CANDIDATES_FILE = path.join(KNOWLEDGE_DIR, 'candidates.jsonl');
const REVIEW_FILE = path.join(KNOWLEDGE_DIR, 'review-queue.jsonl');
const QUIZ_TYPES_FILE = process.env.SABA_QUIZ_TYPES_FILE || path.join(APP_ROOT, 'docs', 'QUIZ-TYPES.md');
const PROMOTION_SUCCESS_COUNT = 3;
const PROMOTION_DISTINCT_TARGETS = 2;

function ensureKnowledge() {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  if (!fs.existsSync(STRATEGIES_FILE)) {
    fs.writeFileSync(STRATEGIES_FILE, JSON.stringify({ schemaVersion: 1, strategies: {} }, null, 2));
  }
  if (!fs.existsSync(CANDIDATES_FILE)) fs.writeFileSync(CANDIDATES_FILE, '');
  if (!fs.existsSync(REVIEW_FILE)) fs.writeFileSync(REVIEW_FILE, '');
}

function readStrategies() {
  ensureKnowledge();
  try {
    const value = JSON.parse(fs.readFileSync(STRATEGIES_FILE, 'utf8'));
    return value?.strategies ? value : { schemaVersion: 1, strategies: {} };
  } catch {
    return { schemaVersion: 1, strategies: {} };
  }
}

function writeStrategies(value) {
  ensureKnowledge();
  fs.writeFileSync(STRATEGIES_FILE, JSON.stringify(value, null, 2));
}

function syncQuizTypesEvidence(store = readStrategies()) {
  const startMarker = '<!-- AUTO-EVIDENCE:START -->';
  const endMarker = '<!-- AUTO-EVIDENCE:END -->';
  const strategies = Object.values(store.strategies)
    .sort((a, b) => String(a.capabilityId).localeCompare(String(b.capabilityId)));
  const lines = [
    startMarker,
    '## Automated evidence summary',
    '',
    'This section is generated from verified attempt evidence in `data/knowledge/strategies.json`.',
    '',
  ];
  if (!strategies.length) {
    lines.push('- No measured strategy evidence yet.');
  } else {
    for (const strategy of strategies) {
      lines.push(
        `- **${strategy.capabilityId}** \`${strategy.fingerprint || 'unfingerprinted'}\` — ` +
        `${strategy.status}; ${strategy.successes} verified success(es), ${strategy.failures} failure(s), ` +
        `${strategy.targets.length} distinct target(s).`,
      );
    }
  }
  lines.push('', endMarker);
  let document = '';
  try { document = fs.readFileSync(QUIZ_TYPES_FILE, 'utf8'); } catch { return; }
  const generated = lines.join('\n');
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);
  document = pattern.test(document)
    ? document.replace(pattern, generated)
    : `${document.trimEnd()}\n\n---\n\n${generated}\n`;
  fs.writeFileSync(QUIZ_TYPES_FILE, document);
}

function appendJsonl(file, value) {
  ensureKnowledge();
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function strategyKey(capabilityId, capabilityVersion, fingerprint) {
  return `${capabilityId || 'unknown'}@${capabilityVersion || 1}:${fingerprint || 'unfingerprinted'}`;
}

function validateActions(actions = []) {
  if (!Array.isArray(actions)) return false;
  return actions.every((action) => SAFE_ACTIONS.has(typeof action === 'string' ? action : action?.type));
}

function observeOutcome(observation) {
  const now = observation.ts || new Date().toISOString();
  const store = readStrategies();
  const key = strategyKey(observation.capabilityId, observation.capabilityVersion, observation.fingerprint);
  const current = store.strategies[key] || {
    key,
    capabilityId: observation.capabilityId || 'unknown',
    capabilityVersion: observation.capabilityVersion || 1,
    fingerprint: observation.fingerprint || null,
    status: 'candidate',
    successes: 0,
    failures: 0,
    targets: [],
    attemptIds: [],
    successAttemptIds: [],
    failureAttemptIds: [],
    actions: observation.actions || [],
    createdAt: now,
    updatedAt: now,
  };

  if (observation.actions && !validateActions(observation.actions)) {
    queueReview({
      type: 'unsafe-actions',
      title: `Unsafe learned action sequence for ${key}`,
      fingerprint: observation.fingerprint,
      attemptId: observation.attemptId,
      detail: 'Candidate contained actions outside the safe DSL.',
    });
    return { ...current, status: 'needs-review' };
  }

  current.successAttemptIds = current.successAttemptIds || [];
  current.failureAttemptIds = current.failureAttemptIds || [];
  if (observation.attemptId && !current.attemptIds.includes(observation.attemptId)) {
    current.attemptIds.push(observation.attemptId);
  }
  if (observation.targetId && !current.targets.includes(observation.targetId)) {
    current.targets.push(observation.targetId);
  }
  if (observation.verified && observation.outcome === 'success') {
    if (!observation.attemptId || !current.successAttemptIds.includes(observation.attemptId)) {
      current.successes += 1;
      if (observation.attemptId) current.successAttemptIds.push(observation.attemptId);
    }
    current.lastSuccessAt = now;
  } else if (observation.outcome === 'failure') {
    if (!observation.attemptId || !current.failureAttemptIds.includes(observation.attemptId)) {
      current.failures += 1;
      if (observation.attemptId) current.failureAttemptIds.push(observation.attemptId);
    }
    current.lastFailureAt = now;
    current.lastFailureSignature = observation.failureSignature || 'unknown-failure';
    if (current.status === 'promoted') {
      current.status = 'needs-review';
      current.demotedAt = now;
      queueReview({
        type: 'strategy-regression',
        title: `Regression detected for ${current.capabilityId}`,
        strategyKey: current.key,
        fingerprint: current.fingerprint,
        attemptId: observation.attemptId,
        detail: current.lastFailureSignature,
      });
    }
  }

  const hasThreshold = (
    current.successes >= PROMOTION_SUCCESS_COUNT &&
    current.targets.length >= PROMOTION_DISTINCT_TARGETS
  );
  const hasUnresolvedConflict = (
    current.lastFailureAt &&
    (!current.lastSuccessAt || current.lastFailureAt > current.lastSuccessAt)
  );
  if (hasThreshold && !hasUnresolvedConflict && current.status === 'candidate') {
    current.status = 'promoted';
    current.promotedAt = now;
  }
  current.updatedAt = now;
  store.strategies[key] = current;
  writeStrategies(store);
  syncQuizTypesEvidence(store);
  appendJsonl(CANDIDATES_FILE, {
    schemaVersion: 1,
    ts: now,
    event: 'observation',
    key,
    attemptId: observation.attemptId || null,
    outcome: observation.outcome,
    verified: !!observation.verified,
    targetId: observation.targetId || null,
    status: current.status,
  });
  return current;
}

function queueReview(item) {
  const row = {
    schemaVersion: 1,
    ts: item.ts || new Date().toISOString(),
    id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    status: item.status || 'open',
    type: item.type || 'unknown',
    title: item.title || 'Learning review',
    fingerprint: item.fingerprint || null,
    attemptId: item.attemptId || null,
    artifact: item.artifact || null,
    detail: item.detail || '',
    nextAction: item.nextAction || 'Inspect the linked evidence and classify the safest reusable action.',
    strategyKey: item.strategyKey || null,
    diagnosis: item.diagnosis || null,
  };
  appendJsonl(REVIEW_FILE, row);
  return row;
}

function suggestNextAction(fingerprint, detected = 'unknown') {
  const matches = Object.values(readStrategies().strategies)
    .filter((strategy) => strategy.fingerprint && strategy.fingerprint === fingerprint)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const promoted = matches.find((strategy) => strategy.status === 'promoted');
  if (promoted) {
    return {
      kind: 'retry-promoted',
      capabilityId: promoted.capabilityId,
      detail: `A promoted ${promoted.capabilityId} strategy matches this fingerprint; replay it in dry-run mode first.`,
    };
  }
  if (matches.length) {
    return {
      kind: 'compare-candidate',
      capabilityId: matches[0].capabilityId,
      detail: `Compare this capture with ${matches.length} prior candidate observation(s) before adding a new strategy.`,
    };
  }
  if (detected === 'server-assessment') {
    return {
      kind: 'guarded-assessment-inspection',
      capabilityId: 'server-assessment',
      detail: 'Read question count, attempt limit, stems, and options without submitting; build a confidence-scored answer plan.',
    };
  }
  return {
    kind: 'inspect-capture',
    capabilityId: null,
    detail: 'Inspect normalized-probe.json, visible text, controls, and frames; define only safe DSL steps and a verifier.',
  };
}

function readJsonl(file) {
  ensureKnowledge();
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function getLearningSummary() {
  const strategies = Object.values(readStrategies().strategies);
  const reviewEvents = readJsonl(REVIEW_FILE);
  const reviewById = new Map();
  for (const review of reviewEvents) {
    const previous = reviewById.get(review.id) || {};
    reviewById.set(review.id, { ...previous, ...review });
  }
  const reviews = [...reviewById.values()];
  return {
    thresholds: {
      verifiedSuccesses: PROMOTION_SUCCESS_COUNT,
      distinctTargets: PROMOTION_DISTINCT_TARGETS,
    },
    counts: {
      promoted: strategies.filter((strategy) => strategy.status === 'promoted').length,
      candidates: strategies.filter((strategy) => strategy.status === 'candidate').length,
      needsReview: strategies.filter((strategy) => strategy.status === 'needs-review').length,
      openReviews: reviews.filter((review) => review.status === 'open').length,
    },
    strategies: strategies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    reviews: reviews.filter((review) => review.status === 'open').slice(-50).reverse(),
  };
}

function rankCandidate(capabilityId, fingerprint, baseConfidence) {
  const strategies = Object.values(readStrategies().strategies)
    .filter((strategy) => strategy.capabilityId === capabilityId);
  const exact = strategies.find((strategy) => strategy.fingerprint === fingerprint);
  const measured = exact || strategies
    .filter((strategy) => strategy.status === 'promoted')
    .sort((a, b) => b.successes - a.successes)[0] || null;
  if (!measured) {
    return {
      confidence: baseConfidence,
      evidence: 'No measured strategy evidence matches; using the registry fingerprint.',
      strategy: null,
    };
  }
  const adjustment = measured.status === 'promoted'
    ? (exact ? 0.08 : 0.03)
    : measured.status === 'needs-review'
      ? -0.25
      : Math.min(0.04, measured.successes * 0.01);
  return {
    confidence: Math.max(0, Math.min(0.999, baseConfidence + adjustment)),
    evidence: `${exact ? 'Exact' : 'Capability-level'} measured evidence: ${measured.status}, ` +
      `${measured.successes} verified success(es), ${measured.failures} failure(s), ${measured.targets.length} target(s).`,
    strategy: measured,
  };
}

function findPromotedStrategy(fingerprint) {
  return Object.values(readStrategies().strategies)
    .filter((strategy) => (
      strategy.fingerprint === fingerprint &&
      strategy.status === 'promoted' &&
      validateActions(strategy.actions)
    ))
    .sort((a, b) => b.successes - a.successes)[0] || null;
}

function resolveReview(id, note = '') {
  const original = readJsonl(REVIEW_FILE).reverse().find((row) => row.id === id && row.type);
  const row = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    id,
    status: 'resolved',
    resolution: note,
  };
  appendJsonl(REVIEW_FILE, row);
  if (original?.strategyKey) {
    const store = readStrategies();
    const strategy = store.strategies[original.strategyKey];
    if (strategy) {
      strategy.status = (
        strategy.successes >= PROMOTION_SUCCESS_COUNT &&
        strategy.targets.length >= PROMOTION_DISTINCT_TARGETS
      ) ? 'promoted' : 'candidate';
      strategy.reviewResolvedAt = row.ts;
      strategy.updatedAt = row.ts;
      store.strategies[original.strategyKey] = strategy;
      writeStrategies(store);
      syncQuizTypesEvidence(store);
    }
  }
  return row;
}

module.exports = {
  CANDIDATES_FILE,
  KNOWLEDGE_DIR,
  PROMOTION_DISTINCT_TARGETS,
  PROMOTION_SUCCESS_COUNT,
  REVIEW_FILE,
  STRATEGIES_FILE,
  ensureKnowledge,
  getLearningSummary,
  findPromotedStrategy,
  observeOutcome,
  queueReview,
  readStrategies,
  rankCandidate,
  resolveReview,
  strategyKey,
  suggestNextAction,
  syncQuizTypesEvidence,
  validateActions,
};
