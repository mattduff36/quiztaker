// lib/attempt-ledger.js
//
// Append-only, versioned event ledger for every detect/confirm/run/verify cycle.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { dataPath } = require('./paths');

const ATTEMPT_DIR = process.env.SABA_ATTEMPT_DIR || dataPath('attempts');
const LEDGER_FILE = path.join(ATTEMPT_DIR, 'events.jsonl');
const SCHEMA_VERSION = 1;

function ensureLedger() {
  fs.mkdirSync(ATTEMPT_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, '');
}

function appendEvent(attemptId, event, data = {}, now = new Date()) {
  ensureLedger();
  const row = {
    schemaVersion: SCHEMA_VERSION,
    ts: now.toISOString(),
    attemptId,
    event,
    ...data,
  };
  fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(row)}\n`);
  return row;
}

function createAttempt(data = {}) {
  const attemptId = data.attemptId || randomUUID();
  appendEvent(attemptId, 'attempt-created', {
    source: data.source || 'unknown',
    capabilityId: data.capabilityId || null,
    capabilityVersion: data.capabilityVersion || null,
    fingerprint: data.fingerprint || null,
    target: data.target || null,
    planId: data.planId || null,
    risk: data.risk || 'none',
  });
  return attemptId;
}

function recordConfirmation(attemptId, confirmed, data = {}) {
  return appendEvent(attemptId, confirmed ? 'plan-confirmed' : 'plan-cancelled', data);
}

function recordStep(attemptId, step, data = {}) {
  return appendEvent(attemptId, 'step', { step, ...data });
}

function finishAttempt(attemptId, outcome, data = {}) {
  return appendEvent(attemptId, 'attempt-finished', {
    outcome,
    verified: !!data.verified,
    status: data.status || null,
    failureSignature: data.failureSignature || null,
    artifacts: data.artifacts || [],
    exitCode: data.exitCode ?? null,
    ...data,
  });
}

function readEvents() {
  ensureLedger();
  return fs.readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readAttempts() {
  const attempts = new Map();
  for (const event of readEvents()) {
    const current = attempts.get(event.attemptId) || {
      attemptId: event.attemptId,
      events: [],
      createdAt: event.ts,
    };
    current.events.push(event);
    if (event.event === 'attempt-created') Object.assign(current, event);
    if (event.event === 'attempt-finished') {
      current.finishedAt = event.ts;
      current.outcome = event.outcome;
      current.verified = event.verified;
      current.status = event.status;
      current.failureSignature = event.failureSignature;
      current.artifacts = event.artifacts || [];
      current.exitCode = event.exitCode;
      current.diagnosis = event.diagnosis || null;
    }
    if (event.event === 'attempt-diagnosed') {
      current.diagnosis = event.diagnosis || current.diagnosis;
      current.failureSignature = event.failureSignature || current.failureSignature;
      current.artifacts = [...new Set([...(current.artifacts || []), ...(event.artifacts || [])])];
    }
    attempts.set(event.attemptId, current);
  }
  return [...attempts.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  ATTEMPT_DIR,
  LEDGER_FILE,
  SCHEMA_VERSION,
  appendEvent,
  createAttempt,
  ensureLedger,
  finishAttempt,
  readAttempts,
  readEvents,
  recordConfirmation,
  recordStep,
};
