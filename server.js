#!/usr/bin/env node
// server.js
//
// Local-only dashboard for the Saba learning automation agent.
// Serves public/ and exposes a small JSON API plus an SSE run-streamer so the
// UI can invoke the whitelisted pw-* scripts and watch their stdout live.
//
// Usage:
//   npm start           # then open http://127.0.0.1:3000
//   PORT=4000 npm start # listen on 127.0.0.1:4000
//   HOST=0.0.0.0 npm start  # explicitly allow network access
//
// No auth: intended for localhost use only.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { readMerged } = require('./lib/history');
const { buildSessionReport, commitSession } = require('./lib/session-report');
const {
  CAPABILITIES,
  getCapability,
  listPublicCapabilities,
} = require('./lib/capabilities');
const {
  createAttempt,
  finishAttempt,
  recordConfirmation,
  recordStep,
} = require('./lib/attempt-ledger');
const { classifyOutcome } = require('./lib/outcome');
const { authorizeRun } = require('./lib/plan-policy');
const { diagnoseRun } = require('./lib/run-diagnosis');
const { dataPath } = require('./lib/paths');
const {
  getLearningSummary,
  observeOutcome,
  queueReview,
  resolveReview,
  suggestNextAction,
} = require('./lib/learning-engine');

// Port precedence: --port <n> CLI flag, then $PORT, then 3000.
function resolvePort() {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  return Number(process.env.PORT || 3000);
}
const PORT = resolvePort();
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// Inline SVG favicon so the browser doesn't log a 404 for /favicon.ico.
const FAVICON = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#4f9dff"/><text x="16" y="22" font-family="system-ui,sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="#041020">SA</text></svg>`,
  'utf8'
);
app.get('/favicon.ico', (_req, res) => {
  res.set('Content-Type', 'image/svg+xml').send(FAVICON);
});

// ---- helpers -------------------------------------------------------------

// Run a node script once and resolve with { code, stdout, stderr }.
function runOnce(script, args = [], timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message) });
    });
  });
}

function tryParseJson(s) {
  if (!s) return null;
  // Scripts sometimes print a leading log line before the JSON; grab from the
  // first { or [ to the end.
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

// ---- recent URLs (persisted across sessions) -----------------------------

const RECENT_URLS_FILE = dataPath('recent-urls.json');
const RECENT_URLS_MAX = 40;

function readRecentUrls() {
  try { return JSON.parse(fs.readFileSync(RECENT_URLS_FILE, 'utf8')); }
  catch { return []; }
}

function writeRecentUrls(list) {
  try {
    fs.mkdirSync(path.dirname(RECENT_URLS_FILE), { recursive: true });
    fs.writeFileSync(RECENT_URLS_FILE, JSON.stringify(list, null, 2));
  } catch {}
}

// Upsert the URLs of currently-open tabs into the persisted list.
function recordRecentUrls(tabs) {
  if (!Array.isArray(tabs) || !tabs.length) return;
  const list = readRecentUrls();
  const byUrl = new Map(list.map((r) => [r.url, r]));
  const now = new Date().toISOString();
  for (const t of tabs) {
    const url = t && t.url;
    if (!url || /^(about:|chrome:|chrome-extension:|devtools:)/i.test(url)) continue;
    const existing = byUrl.get(url);
    if (existing) {
      existing.lastSeen = now;
      existing.count = (existing.count || 1) + 1;
      if (t.title) existing.title = t.title;
    } else {
      const rec = { url, title: t.title || '', lastSeen: now, count: 1 };
      byUrl.set(url, rec);
    }
  }
  const merged = [...byUrl.values()]
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .slice(0, RECENT_URLS_MAX);
  writeRecentUrls(merged);
}

// The executable whitelist is derived from the capability registry.
const SCRIPT_WHITELIST = new Set(CAPABILITIES.map((capability) => capability.script));

// Docs the dashboard is allowed to read.
const DOC_WHITELIST = new Set([
  'AGENTS.md',
  'docs/QUIZ-TYPES.md',
  'docs/RUNBOOK.md',
]);

// Live runs, keyed by runId. Each: { child, buffered:[], done:bool, code }.
const runs = new Map();
const plans = new Map();
const PLAN_TTL_MS = 10 * 60 * 1000;
const RISK_ORDER = ['none', 'low', 'medium', 'high'];

function higherRisk(left, right) {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(left), RISK_ORDER.indexOf(right), 0)];
}

function createStoredPlan(input, source = 'dashboard') {
  const capability = getCapability(input.capabilityId);
  if (!capability) throw new Error(`Unknown capability: ${input.capabilityId}`);
  const planId = randomUUID();
  const createdAt = new Date();
  const plan = {
    planId,
    source,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    script: capability.script,
    args: Array.isArray(input.args) ? input.args.map(String) : (capability.args || []),
    label: input.label || capability.label,
    risk: higherRisk(capability.risk, input.risk),
    mutatesCourse: capability.mutatesCourse,
    verifier: capability.verifier,
    steps: Array.isArray(input.steps) ? input.steps : [],
    constraints: input.constraints || null,
    targets: Array.isArray(input.targets) ? input.targets : [],
    confidence: Number(input.confidence || 0),
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    fingerprint: input.fingerprint || null,
    tabIdx: input.tabIdx ?? null,
    confirmed: false,
    consumed: false,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
  };
  plan.attemptId = createAttempt({
    source,
    capabilityId: plan.capabilityId,
    capabilityVersion: plan.capabilityVersion,
    fingerprint: plan.fingerprint,
    target: plan.targets,
    planId,
    risk: plan.risk,
  });
  plans.set(planId, plan);
  return plan;
}

function getStoredPlan(planId) {
  const plan = plans.get(planId);
  if (!plan) return null;
  if (Date.parse(plan.expiresAt) < Date.now()) {
    plans.delete(planId);
    return null;
  }
  return plan;
}

function publicPlan(plan) {
  if (!plan) return null;
  const { confirmed, consumed, ...value } = plan;
  return value;
}

// Track the long-lived CDP browser launcher so we can stop it gracefully.
let cdpLauncherRunId = null;

// ---- read-only status endpoints -----------------------------------------

let cdpCache = { at: 0, value: null };
app.get('/api/cdp', async (_req, res) => {
  if (Date.now() - cdpCache.at < 3000 && cdpCache.value) {
    return res.json(cdpCache.value);
  }
  const r = await runOnce('pw-cdp-check.js', [], 5000);
  const parsed = tryParseJson(r.stdout) || { ok: r.code === 0 };
  cdpCache = { at: Date.now(), value: parsed };
  res.json(parsed);
});

// Stop the CDP browser. Prefer SIGINT'ing our own launcher (graceful close via
// its SIGINT handler); otherwise ask Chrome to close over CDP.
async function stopCdpBrowser() {
  cdpCache = { at: 0, value: null };
  if (cdpLauncherRunId && runs.has(cdpLauncherRunId)) {
    const rec = runs.get(cdpLauncherRunId);
    try { rec.child.kill('SIGINT'); } catch {}
    cdpLauncherRunId = null;
    return { ok: true, method: 'launcher-sigint' };
  }
  const r = await runOnce('pw-close-browser.js', [], 15000);
  const parsed = tryParseJson(r.stdout);
  return parsed || { ok: r.code === 0, method: 'close-script' };
}

app.post('/api/cdp/stop', async (_req, res) => {
  try {
    res.json(await stopCdpBrowser());
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Preview what the current session contains (no writes, no close).
app.get('/api/session/report', (_req, res) => {
  try {
    res.json(buildSessionReport());
  } catch (e) {
    res.json({ error: e.message });
  }
});

// End the session: aggregate logs -> write recap + history row + needs-review,
// advance the marker, then close the CDP browser. Returns the report so the UI
// can show a summary + "you can now close this window".
app.post('/api/session/end', async (_req, res) => {
  try {
    const now = new Date();
    const report = buildSessionReport(now);
    const files = commitSession(report, now);
    const stop = await stopCdpBrowser();
    res.json({ ok: true, report, files, stop });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Note: these polled endpoints intentionally return HTTP 200 with an error
// envelope on failure (rather than 5xx), so a transient CDP-down poll doesn't
// spam the browser console with red network errors. The client checks the
// payload shape instead of the status code.
app.get('/api/tabs', async (_req, res) => {
  const r = await runOnce('pw-list-tabs.js', [], 20000);
  const parsed = tryParseJson(r.stdout);
  if (!parsed) return res.json({ error: 'could not read tabs', stderr: r.stderr });
  try { recordRecentUrls(parsed); } catch {}
  res.json(parsed);
});

app.get('/api/recent-urls', (_req, res) => {
  res.json(readRecentUrls());
});

app.get('/api/capabilities', (_req, res) => {
  res.json(listPublicCapabilities());
});

app.get('/api/learning', (_req, res) => {
  res.json(getLearningSummary());
});

app.post('/api/learning/reviews/:id/resolve', (req, res) => {
  res.json(resolveReview(req.params.id, req.body?.note || 'Resolved from dashboard.'));
});

app.post('/api/recent-urls/forget', (req, res) => {
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  writeRecentUrls(readRecentUrls().filter((r) => r.url !== url));
  res.json({ ok: true });
});

app.get('/api/cert', async (_req, res) => {
  const r = await runOnce('pw-cert-status.js', [], 30000);
  const parsed = tryParseJson(r.stdout);
  if (!parsed) return res.json({ error: 'could not read cert', stderr: r.stderr });
  res.json(parsed);
});

app.get('/api/detect', async (req, res) => {
  const tabIdx = /^\d+$/.test(String(req.query.tabIdx || '')) ? String(req.query.tabIdx) : null;
  const r = await runOnce('pw-detect.js', tabIdx == null ? [] : [tabIdx], 30000);
  const parsed = tryParseJson(r.stdout);
  if (!parsed) return res.json({ error: 'could not detect', stderr: r.stderr });
  if (parsed.plan && !parsed.selection) {
    try {
      const stored = createStoredPlan({
        ...parsed.plan,
        fingerprint: parsed.fingerprint,
        tabIdx: parsed.tabIdx,
      }, 'auto-detect');
      parsed.planId = stored.planId;
      parsed.attemptId = stored.attemptId;
    } catch (error) {
      parsed.planError = error.message;
    }
  }
  res.json(parsed);
});

app.post('/api/plans', (req, res) => {
  try {
    const plan = createStoredPlan(req.body || {}, 'manual-capability');
    res.json(publicPlan(plan));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/plans/:planId/confirm', (req, res) => {
  const plan = getStoredPlan(req.params.planId);
  if (!plan || plan.consumed) return res.status(404).json({ error: 'plan not found or expired' });
  plan.confirmed = true;
  plan.confirmedAt = new Date().toISOString();
  recordConfirmation(plan.attemptId, true, {
    planId: plan.planId,
    targets: plan.targets,
  });
  res.json({ ok: true, planId: plan.planId, attemptId: plan.attemptId });
});

app.post('/api/plans/:planId/cancel', (req, res) => {
  const plan = getStoredPlan(req.params.planId);
  if (!plan || plan.consumed) return res.status(404).json({ error: 'plan not found or expired' });
  plan.consumed = true;
  recordConfirmation(plan.attemptId, false, { planId: plan.planId });
  finishAttempt(plan.attemptId, 'cancelled', {
    verified: false,
    status: 'cancelled-by-user',
  });
  res.json({ ok: true });
});

app.get('/api/history', (_req, res) => {
  try {
    res.json(readMerged());
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/docs', (req, res) => {
  const name = String(req.query.name || '');
  if (!DOC_WHITELIST.has(name)) {
    return res.status(400).json({ error: 'doc not allowed', allowed: [...DOC_WHITELIST] });
  }
  fs.readFile(path.join(ROOT, name), 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'not found' });
    res.json({ name, content: data });
  });
});

// ---- run + stream endpoints ----------------------------------------------

app.post('/api/run', (req, res) => {
  const { script, args, planId } = req.body || {};
  if (!SCRIPT_WHITELIST.has(script)) {
    return res.status(400).json({ error: 'script not allowed', allowed: [...SCRIPT_WHITELIST] });
  }
  const safeArgs = Array.isArray(args) ? args.map(String) : [];
  let plan = planId ? getStoredPlan(String(planId)) : null;
  const authorization = authorizeRun({ script, args: safeArgs, plan });
  if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
  const capability = authorization.capability;
  if (!plan) {
    plan = createStoredPlan({
      capabilityId: capability.id,
      args: safeArgs,
      label: capability.label,
    }, 'direct-readonly');
    plan.confirmed = true;
    recordConfirmation(plan.attemptId, true, { automatic: true, reason: 'read-only capability' });
  }
  plan.consumed = true;
  recordStep(plan.attemptId, 'executor-started', {
    script,
    args: safeArgs,
  });

  const runId = randomUUID();
  const child = spawn(process.execPath, [script, ...safeArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      SABA_ATTEMPT_ID: plan.attemptId,
      SABA_CAPABILITY_ID: plan.capabilityId,
      SABA_CAPABILITY_VERSION: String(plan.capabilityVersion),
      SABA_FINGERPRINT: plan.fingerprint || '',
    },
  });
  const rec = {
    child,
    buffered: [],
    done: false,
    code: null,
    clients: new Set(),
    script,
    args: safeArgs,
    output: '',
    attemptId: plan.attemptId,
    plan,
  };
  runs.set(runId, rec);

  // Remember the CDP browser launcher so /api/cdp/stop can SIGINT it (its
  // handler closes Chrome cleanly).
  if (script === 'start-cdp-browser.js') cdpLauncherRunId = runId;

  const push = (stream, text) => {
    const chunk = { stream, text };
    rec.buffered.push(chunk);
    rec.output += text;
    for (const c of rec.clients) sendSse(c, 'line', chunk);
  };
  child.stdout.on('data', (d) => push('stdout', d.toString()));
  child.stderr.on('data', (d) => push('stderr', d.toString()));
  child.on('close', (code) => {
    rec.done = true;
    rec.code = code;
    const result = classifyOutcome({ script, code, output: rec.output });
    const diagnosis = diagnoseRun({
      script,
      code,
      output: rec.output,
      outcome: result,
    });
    if (diagnosis) {
      result.failureSignature = diagnosis.likelyCause.code;
      result.artifacts = [...new Set([...(result.artifacts || []), ...(diagnosis.artifacts || [])])];
    }
    rec.result = result;
    rec.diagnosis = diagnosis;
    finishAttempt(rec.attemptId, result.outcome, {
      ...result,
      diagnosis,
      exitCode: code,
      capabilityId: rec.plan.capabilityId,
      capabilityVersion: rec.plan.capabilityVersion,
      fingerprint: rec.plan.fingerprint,
      targets: rec.plan.targets,
    });
    const targets = rec.plan.targets.length ? rec.plan.targets : [{ title: rec.plan.label }];
    for (const target of targets) {
      observeOutcome({
        ts: new Date().toISOString(),
        attemptId: rec.attemptId,
        capabilityId: rec.plan.capabilityId,
        capabilityVersion: rec.plan.capabilityVersion,
        fingerprint: rec.plan.fingerprint,
        targetId: target.id || target.title || String(target),
        actions: rec.plan.steps,
        outcome: result.outcome,
        verified: result.verified,
        failureSignature: result.failureSignature,
      });
    }
    if (result.outcome === 'failure') {
      const nextAction = suggestNextAction(rec.plan.fingerprint, rec.plan.capabilityId);
      queueReview({
        type: 'attempt-failure',
        title: `Review failed ${rec.plan.capabilityId} attempt`,
        fingerprint: rec.plan.fingerprint,
        attemptId: rec.attemptId,
        artifact: result.artifacts[0] || null,
        detail: diagnosis?.likelyCause?.explanation || result.failureSignature || result.status,
        nextAction: diagnosis?.recommendations?.[0] || nextAction.detail,
        diagnosis,
      });
    }
    if (cdpLauncherRunId === runId) cdpLauncherRunId = null;
    for (const c of rec.clients) {
      sendSse(c, 'end', { code, result, diagnosis });
      c.end();
    }
    // keep the record a short while so late-joining clients still see the tail
    setTimeout(() => runs.delete(runId), 60000);
  });
  child.on('error', (e) => push('stderr', String(e.message)));

  res.json({ runId, script, args: safeArgs, attemptId: plan.attemptId });
});

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get('/api/runs/:runId/stream', (req, res) => {
  const rec = runs.get(req.params.runId);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  if (!rec) {
    sendSse(res, 'end', { code: null, missing: true });
    return res.end();
  }
  // replay buffered output first
  for (const chunk of rec.buffered) sendSse(res, 'line', chunk);
  if (rec.done) {
    sendSse(res, 'end', { code: rec.code, result: rec.result, diagnosis: rec.diagnosis });
    return res.end();
  }
  rec.clients.add(res);
  req.on('close', () => rec.clients.delete(res));
});

app.post('/api/runs/:runId/kill', (req, res) => {
  const rec = runs.get(req.params.runId);
  if (!rec) return res.status(404).json({ error: 'no such run' });
  recordStep(rec.attemptId, 'executor-cancel-requested', { runId: req.params.runId });
  try { rec.child.kill(); } catch {}
  res.json({ ok: true });
});

// ---- live reload (dev convenience) ---------------------------------------
//
// The browser opens an EventSource to /api/livereload. We push a "reload" event
// when anything under public/ changes. Server-side code changes are handled by
// running with `node --watch` (see the "dev" npm script): the process restarts,
// this SSE connection drops, and the client reloads on the next "hello".
const lrClients = new Set();
app.get('/api/livereload', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write('event: hello\ndata: {}\n\n');
  lrClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(ping); lrClients.delete(res); });
});

let lrDebounce = null;
function broadcastReload() {
  if (lrDebounce) clearTimeout(lrDebounce);
  lrDebounce = setTimeout(() => {
    for (const c of lrClients) { try { c.write('event: reload\ndata: {}\n\n'); } catch {} }
  }, 120);
}
try {
  fs.watch(path.join(ROOT, 'public'), { recursive: true }, () => broadcastReload());
} catch (e) {
  console.log('(live reload watch unavailable:', e.message + ')');
}

app.listen(PORT, HOST, () => {
  console.log(`Saba agent dashboard: http://${HOST}:${PORT}`);
});
