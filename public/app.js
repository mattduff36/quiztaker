// public/app.js — Saba agent dashboard client (vanilla, no build step).

// ---- live reload ---------------------------------------------------------
// Reloads the page when the server pushes a "reload" (a public/ file changed)
// or when the server comes back after a `node --watch` restart (a fresh
// "hello" after we'd already connected once).
(function liveReload() {
  let everConnected = false;
  const es = new EventSource('/api/livereload');
  es.addEventListener('reload', () => location.reload());
  es.addEventListener('hello', () => {
    if (everConnected) location.reload();
    everConnected = true;
  });
  // On error the browser auto-reconnects; the next "hello" handles the reload.
})();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  tabs: [],
  cert: null,
  capabilities: [],
  selectedTabIdx: null,
  pendingPlan: null,
  activeRunId: null,
  eventSource: null,
};

// ---- API helpers ---------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---- View switching ------------------------------------------------------

function showView(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'learning') loadLearning();
  if (name === 'docs') loadDoc(currentDoc);
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---- Capability cards ----------------------------------------------------

function renderCards() {
  const box = $('#cards');
  box.innerHTML = '';
  for (const capability of state.capabilities.filter((item) => item.card)) {
    const el = document.createElement('button');
    el.className = 'card';
    el.innerHTML = `<div class="card-title"></div><div class="card-desc"></div>`;
    el.querySelector('.card-title').textContent = capability.label;
    el.querySelector('.card-desc').textContent = capability.description;
    el.addEventListener('click', async () => {
      if (capability.picker === 'cert-courses') {
        openCourseSelect({ capability });
        return;
      }
      const args = [...(capability.args || [])];
      if (
        ['scorm-complete', 'container-batch', 'learn-capture'].includes(capability.id) &&
        Number.isInteger(state.selectedTabIdx) &&
        !args.some((arg) => /^\d+$/.test(arg))
      ) args.unshift(String(state.selectedTabIdx));
      try {
        const plan = await api('/api/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            capabilityId: capability.id,
            args,
            label: capability.label,
            tabIdx: state.selectedTabIdx,
          }),
        });
        if (capability.mutatesCourse) openPlanConfirm(plan, capability.description);
        else await confirmAndRunPlan(plan);
      } catch (error) {
        showBanner('error', 'Could not create plan', error.message);
      }
    });
    box.appendChild(el);
  }
}

async function loadCapabilities() {
  try {
    state.capabilities = await api('/api/capabilities');
    renderCards();
  } catch (error) {
    $('#cards').innerHTML = `<p class="muted">Could not load capabilities (${escapeHtml(error.message)}).</p>`;
  }
}

// ---- Auto-detect tile ----------------------------------------------------

$('#autodetect-tile').addEventListener('click', async () => {
  const tile = $('#autodetect-tile');
  const status = $('#autodetect-status');
  tile.disabled = true;
  status.textContent = 'Detecting…';
  let d;
  try {
    const tabQuery = Number.isInteger(state.selectedTabIdx) ? `?tabIdx=${state.selectedTabIdx}` : '';
    d = await api(`/api/detect${tabQuery}`);
  } catch (e) {
    status.textContent = `Detection failed: ${e.message} (is CDP up?)`;
    tile.disabled = false;
    return;
  }
  if (d && d.error) {
    status.textContent = 'Detection failed. Is the CDP browser running?';
    tile.disabled = false;
    return;
  }
  status.textContent = d.detail || `Detected: ${d.detected}`;
  tile.disabled = false;

  if (d.selection) {
    openCourseSelect({
      selection: d.selection,
      action: d.action,
      detection: d,
    });
    return;
  }
  if (!d.plan || !d.planId) return;
  openPlanConfirm({ ...d.plan, planId: d.planId, attemptId: d.attemptId }, d.detail);
});

// ---- Course selection modal (batch) --------------------------------------

// Fetches the current roster and shows a checkbox list so the user can choose
// exactly which unfinished courses the batch should complete.
async function openCourseSelect(options = {}) {
  const modal = $('#course-select');
  const listBox = $('#course-select-list');
  const sub = $('#course-select-sub');
  const runBtn = $('#course-select-run');
  const selectAll = $('#course-select-all');
  const heading = $('#course-select-title');

  modal.hidden = false;
  sub.textContent = options.selection ? 'Reading activities from the current page…' : 'Reading the certification roster…';
  listBox.innerHTML = '<p class="muted">Loading…</p>';
  runBtn.disabled = true;
  selectAll.disabled = false;
  $('#course-select-count').textContent = '';

  let selection;
  if (options.selection) {
    const source = options.selection;
    const isCertification = source.kind === 'cert-courses';
    selection = {
      name: source.title || 'Current course',
      itemLabel: source.itemLabel || (isCertification ? 'course' : 'activity'),
      items: source.items || [],
      completedStatus: source.completedStatus || (isCertification ? 'Successful' : 'Completed'),
      excludedAction: isCertification ? 'CERT' : 'RESULTS',
      capabilityId: options.action?.capabilityId || (isCertification ? 'cert-batch' : 'class-batch'),
      script: options.action?.script || (isCertification ? 'pw-cert-batch.js' : 'pw-class-batch.js'),
      baseArgs: options.action?.args || (isCertification ? [] : [String(source.tabIdx || 0)]),
      refreshAfter: isCertification ? 'cert' : 'tabs',
      fingerprint: options.detection?.fingerprint || null,
      confidence: options.detection?.confidence || 0,
      evidence: options.detection?.evidence || [],
      steps: options.detection?.plan?.steps || options.action?.steps || [],
      risk: options.detection?.plan?.risk || options.action?.risk || 'medium',
      verifier: options.detection?.plan?.verifier || options.action?.verifier,
    };
  } else {
    let cert;
    try {
      cert = await api('/api/cert');
    } catch (e) {
      sub.textContent = `Could not read the roster (${e.message}).`;
      listBox.innerHTML = '';
      return;
    }
    if (!cert || cert.error || !cert.certId) {
      sub.textContent = 'No certification page detected. Open a cert landing tab in the browser, then try again.';
      listBox.innerHTML = '';
      return;
    }
    selection = {
      name: cert.certTitle || cert.certId,
      itemLabel: 'course',
      items: cert.courses || [],
      completedStatus: 'Successful',
      excludedAction: 'CERT',
      capabilityId: options.capability?.id || 'cert-batch',
      script: 'pw-cert-batch.js',
      baseArgs: [],
      refreshAfter: 'cert',
      fingerprint: null,
      confidence: 0,
      evidence: ['Certification roster read from the current landing page.'],
      steps: ['probe', 'launch', 'scorm-complete', 'verify'],
      risk: 'medium',
      verifier: 'cert-roster-successful',
    };
  }

  const unfinished = selection.items.filter((item) => (
    item.status !== selection.completedStatus && item.action !== selection.excludedAction
  ));
  const blocked = unfinished.filter((item) => item.isBlocked);
  const eligible = unfinished.filter((item) => !item.isBlocked);
  const doneCount = selection.items.length - unfinished.length;
  const plural = selection.itemLabel === 'activity' ? 'activities' : `${selection.itemLabel}s`;

  state.courseSelect = { ...selection, eligible, blocked };
  heading.textContent = `Select ${plural} to complete`;

  if (!unfinished.length) {
    sub.textContent = `"${selection.name}" has no unfinished ${plural}.`;
    listBox.innerHTML = '<p class="muted">Nothing to do — everything is already complete.</p>';
    return;
  }

  sub.textContent = `"${selection.name}" — ${eligible.length} runnable, ${blocked.length} blocked` +
    (doneCount ? `, ${doneCount} already complete.` : '.');
  selectAll.checked = true;
  selectAll.disabled = eligible.length === 0;

  listBox.innerHTML = '';
  eligible.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = 'course-select-row';
    row.innerHTML = `
      <input type="checkbox" class="cs-check" checked>
      <span class="cs-info">
        <span class="cs-title"></span>
        <span class="badge ${statusBadgeClass(c.status)} cs-badge"></span>
      </span>
      <span class="cs-action"></span>`;
    row.querySelector('.cs-title').textContent = c.title;
    row.querySelector('.cs-badge').textContent = c.status;
    row.querySelector('.cs-action').textContent = c.action;
    row.querySelector('.cs-check').dataset.idx = String(i);
    listBox.appendChild(row);
  });
  blocked.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'course-select-row cs-blocked';
    row.innerHTML = `
      <input type="checkbox" class="cs-check" disabled>
      <span class="cs-info">
        <span class="cs-title"></span>
        <span class="badge badge-warn cs-badge">Blocked</span>
      </span>
      <span class="cs-action"></span>`;
    row.querySelector('.cs-title').textContent = item.title;
    row.querySelector('.cs-action').textContent = item.blockedReason === 'prerequisites-incomplete'
      ? 'Prerequisites incomplete'
      : 'Separate learning requirement';
    row.title = (item.blockingEvidence || []).join(' • ');
    listBox.appendChild(row);
  });

  updateCourseSelectCount();
  runBtn.disabled = eligible.length === 0;
}

function courseSelectChecks() {
  return [...document.querySelectorAll('#course-select-list .cs-check:not(:disabled)')];
}

function updateCourseSelectCount() {
  const checks = courseSelectChecks();
  const n = checks.filter((c) => c.checked).length;
  const blockedCount = state.courseSelect?.blocked?.length || 0;
  $('#course-select-count').textContent = `${n} of ${checks.length} runnable selected` +
    (blockedCount ? ` · ${blockedCount} blocked` : '');
  $('#course-select-run').textContent = n ? `Run selected (${n})` : 'Run selected';
  $('#course-select-run').disabled = n === 0;
  const all = $('#course-select-all');
  all.checked = n === checks.length;
  all.indeterminate = n > 0 && n < checks.length;
  all.disabled = checks.length === 0;
}

function closeCourseSelect() { $('#course-select').hidden = true; }

$('#course-select-list').addEventListener('change', (e) => {
  if (e.target.classList.contains('cs-check')) updateCourseSelectCount();
});
$('#course-select-all').addEventListener('change', (e) => {
  courseSelectChecks().forEach((c) => { c.checked = e.target.checked; });
  updateCourseSelectCount();
});
$('#course-select-close').addEventListener('click', closeCourseSelect);
$('#course-select-cancel').addEventListener('click', closeCourseSelect);
$('#course-select').addEventListener('click', (e) => {
  if (e.target.id === 'course-select') closeCourseSelect();
});
$('#course-select-run').addEventListener('click', async () => {
  const sel = state.courseSelect;
  if (!sel) return;
  const titles = courseSelectChecks()
    .filter((c) => c.checked)
    .map((c) => sel.eligible[+c.dataset.idx].title);
  if (!titles.length) return;
  const args = titles.map((t) => `--only=${t}`);
  const itemLabel = sel.itemLabel || 'course';
  const itemPlural = itemLabel === 'activity' ? 'activities' : `${itemLabel}s`;
  const label = titles.length === sel.eligible.length
    ? `Batch all ${titles.length} ${titles.length === 1 ? itemLabel : itemPlural}`
    : `Batch ${titles.length} selected ${titles.length === 1 ? itemLabel : itemPlural}`;
  closeCourseSelect();
  try {
    const plan = await api('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: sel.capabilityId,
        args: [...(sel.baseArgs || []), ...args],
        label,
        targets: titles.map((title) => ({ title })),
        confidence: sel.confidence,
        evidence: sel.evidence,
        fingerprint: sel.fingerprint,
        steps: sel.steps,
      }),
    });
    openPlanConfirm({ ...plan, refreshAfter: sel.refreshAfter }, `Complete ${titles.length} selected ${itemLabel}${titles.length === 1 ? '' : 's'}.`);
  } catch (error) {
    showBanner('error', 'Could not create plan', error.message);
  }
});

// ---- Unified plan confirmation ------------------------------------------

function fillList(selector, values, emptyText) {
  const list = $(selector);
  list.innerHTML = '';
  const items = values?.length ? values : [emptyText];
  for (const value of items) {
    const item = document.createElement('li');
    item.textContent = typeof value === 'string' ? value : value.title || value.id || JSON.stringify(value);
    list.appendChild(item);
  }
}

function openPlanConfirm(plan, detail = '') {
  state.pendingPlan = { ...plan, detail };
  $('#plan-confirm-title').textContent = plan.label || 'Confirm automation plan';
  $('#plan-confirm-detail').textContent = detail;
  const meta = $('#plan-confirm-meta');
  meta.innerHTML = '';
  const metaValues = [
    `Risk: ${plan.risk || 'unknown'}`,
    `Confidence: ${Math.round(Number(plan.confidence || 0) * 100)}%`,
    `Verifier: ${plan.verifier || 'process-exit'}`,
  ];
  if (plan.constraints?.remainingAttempts != null) metaValues.push(`Attempts left: ${plan.constraints.remainingAttempts}`);
  if (plan.constraints?.passingScore != null) metaValues.push(`Pass: ${plan.constraints.passingScore}%`);
  if (plan.constraints?.submissionAuthorized === false) metaValues.push('Submission disabled');
  for (const value of metaValues) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = value;
    meta.appendChild(badge);
  }
  fillList('#plan-confirm-evidence', plan.evidence, 'No additional evidence supplied.');
  fillList('#plan-confirm-targets', plan.targets, 'Current browser context.');
  $('#plan-confirm-steps').textContent = `${(plan.steps || []).join(' → ') || 'execute'} → ${plan.verifier || 'verify'}`;
  $('#plan-confirm-run').textContent = plan.mutatesCourse ? 'Confirm and complete' : 'Confirm and run';
  $('#plan-confirm').hidden = false;
}

async function cancelPendingPlan() {
  const plan = state.pendingPlan;
  state.pendingPlan = null;
  $('#plan-confirm').hidden = true;
  if (!plan?.planId) return;
  try { await api(`/api/plans/${plan.planId}/cancel`, { method: 'POST' }); } catch {}
}

async function confirmAndRunPlan(plan) {
  await api(`/api/plans/${plan.planId}/confirm`, { method: 'POST' });
  $('#plan-confirm').hidden = true;
  state.pendingPlan = null;
  runScript(
    plan.script,
    plan.args || [],
    plan.label,
    plan.refreshAfter || 'tabs',
    plan.planId,
  );
}

$('#plan-confirm-run').addEventListener('click', async () => {
  const plan = state.pendingPlan;
  if (!plan) return;
  $('#plan-confirm-run').disabled = true;
  try {
    await confirmAndRunPlan(plan);
  } catch (error) {
    showBanner('error', 'Could not start confirmed plan', error.message);
  } finally {
    $('#plan-confirm-run').disabled = false;
  }
});
$('#plan-confirm-close').addEventListener('click', cancelPendingPlan);
$('#plan-confirm-cancel').addEventListener('click', cancelPendingPlan);
$('#plan-confirm').addEventListener('click', (event) => {
  if (event.target.id === 'plan-confirm') cancelPendingPlan();
});

// ---- Run + SSE stream ----------------------------------------------------

// Some scripts are long-lived daemons that never exit on their own (e.g. the
// CDP browser stays open until you close it). For those, the task is really
// "done" once a ready marker appears in the output — not when the process ends.
const DAEMON_READY = {
  'start-cdp-browser.js': {
    pattern: /(^|\n)Page:\s/,
    title: 'CDP browser ready',
    detail: 'Chrome is up on port 9222 and connected. Leave it running; use Cancel to close it.',
  },
};

async function runScript(script, args, title, refreshAfter, planId = null) {
  const body = $('#output-body');
  body.textContent = '';
  state.currentOutput = '';
  state.daemonReady = false;
  hideBanner();
  $('#output-title').textContent = title || script;
  $('#output-status').textContent = 'running…';
  $('#output-panel').classList.remove('collapsed');
  $('#output-toggle').textContent = 'Hide';
  $('#output-cancel').disabled = false;
  showFloatingProgress(title || script, script);

  // close any prior stream
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }

  let runId;
  try {
    ({ runId } = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, args, planId }),
    }));
  } catch (e) {
    appendLine('stderr', `Failed to start: ${e.message}\n`);
    $('#output-status').textContent = 'error';
    $('#output-cancel').disabled = true;
    return;
  }
  state.activeRunId = runId;

  const es = new EventSource(`/api/runs/${runId}/stream`);
  state.eventSource = es;
  es.addEventListener('line', (ev) => {
    const { stream, text } = JSON.parse(ev.data);
    appendLine(stream, text);
  });
  es.addEventListener('end', (ev) => {
    const { code, diagnosis } = JSON.parse(ev.data);
    $('#output-cancel').disabled = true;
    es.close();
    state.eventSource = null;
    state.activeRunId = null;
    if (state.daemonReady === script) {
      // A daemon we already marked "ready" has now exited — i.e. it was stopped
      // or closed. That's expected, not an error.
      $('#output-status').textContent = 'stopped';
      finishFloatingProgress('warn', 'Stopped');
      showBanner('warn', 'CDP browser stopped', 'The browser process has exited.');
    } else {
      $('#output-status').textContent = code === 0 ? 'done (exit 0)' : `exited ${code}`;
      const summary = summarizeRun(script, code, state.currentOutput);
      finishFloatingProgress(summary.level, summary.title);
      showBanner(summary.level, summary.title, summary.detail);
      if (diagnosis || summary.level === 'error') openRunDiagnosis(diagnosis, summary);
    }
    if (refreshAfter === 'tabs') loadTabs();
    if (refreshAfter === 'cert') { loadCert(); loadTabs(); }
    loadCdp();
  });
  es.onerror = () => {
    // Ignore the error that fires right after a normal end (activeRunId cleared).
    if (!state.activeRunId) return;
    $('#output-status').textContent = 'stream closed';
    $('#output-cancel').disabled = true;
    finishFloatingProgress('error', 'Stream closed');
  };
}

function appendLine(stream, text) {
  state.currentOutput += text;
  updateFloatingFromOutput();
  const body = $('#output-body');
  const span = document.createElement('span');
  if (stream === 'stderr') span.className = 'line-stderr';
  span.textContent = text;
  body.appendChild(span);
  body.scrollTop = body.scrollHeight;
}

// ---- Completion banner + floating progress -------------------------------

function showBanner(level, title, detail) {
  const el = $('#output-banner');
  el.className = `output-banner banner-${level}`;
  el.innerHTML = '';
  const icon = level === 'success' ? '\u2713' : level === 'warn' ? '\u26a0' : '\u2715';
  const t = document.createElement('span');
  t.textContent = `${icon} ${title}`;
  el.appendChild(t);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'banner-detail';
    d.textContent = detail;
    el.appendChild(d);
  }
  el.hidden = false;
}

function hideBanner() {
  const el = $('#output-banner');
  el.hidden = true;
  el.innerHTML = '';
}

// Derive a success/warn/error verdict + human summary from a run's output.
function summarizeRun(script, code, output) {
  const text = output || '';

  // cert-batch: "N/M confirmed Successful"
  let m = text.match(/(\d+)\/(\d+)\s+confirmed Successful/i);
  if (m) {
    const done = +m[1], total = +m[2];
    if (total === 0) return { level: 'warn', title: 'Nothing to complete', detail: 'No unfinished courses were found.' };
    if (done === total) return { level: 'success', title: `All ${total} course(s) completed`, detail: 'Certification roster updated.' };
    const manual = extractManualReview(text);
    return { level: 'warn', title: `${done} of ${total} course(s) completed`, detail: manual || 'Some items need manual review — see output.' };
  }

  // container-batch: "N/M confirmed complete"
  m = text.match(/(\d+)\/(\d+)\s+confirmed complete/i);
  if (m) {
    const done = +m[1], total = +m[2];
    if (done === total && total > 0) return { level: 'success', title: `All ${total} activit${total === 1 ? 'y' : 'ies'} completed`, detail: '' };
    return { level: 'warn', title: `${done} of ${total} activities completed`, detail: 'See output for which ones need attention.' };
  }

  // scorm-complete: success/completion markers
  if (/"success":\s*"passed"|"completion":\s*"completed"|"lesson_status":\s*"passed"/i.test(text)) {
    return { level: 'success', title: 'Course marked complete', detail: 'SCORM reported passed / score 100.' };
  }
  if (/"err":\s*"no-api"|SCORM API not found|no-api/i.test(text)) {
    return { level: 'error', title: 'Could not complete', detail: 'No SCORM API was found on that tab. Launch the course first, then retry.' };
  }

  // dry run
  if (/Will attempt \d+ courses/i.test(text) && /--dry|dry/i.test(script + text) === false) {
    // fall through to generic
  }

  if (code === 0) return { level: 'success', title: 'Done', detail: 'Task finished successfully (exit 0).' };
  return { level: 'error', title: `Failed (exit ${code})`, detail: 'See the output above for details.' };
}

function extractManualReview(text) {
  const idx = text.indexOf('Needs manual review:');
  if (idx === -1) return '';
  const tail = text.slice(idx).split('\n').slice(1)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').trim());
  if (!tail.length) return '';
  return 'Manual review: ' + tail.join('; ');
}

function fallbackRunDiagnosis(summary) {
  return {
    title: summary.title || 'The run needs attention',
    completed: null,
    total: null,
    likelyCause: {
      label: 'The completion result could not be verified',
      confidence: 0.65,
      explanation: summary.detail || 'The run ended without enough evidence to confirm every selected item.',
    },
    evidence: [],
    affectedTargets: [],
    recommendations: ['Review the run output and Learning queue, then rerun Auto-detect for the remaining items.'],
  };
}

function appendTextItems(selector, items, emptyText = '') {
  const list = $(selector);
  list.innerHTML = '';
  const values = items?.length ? items : (emptyText ? [emptyText] : []);
  for (const value of values) {
    const item = document.createElement('li');
    item.textContent = value;
    list.appendChild(item);
  }
}

function openRunDiagnosis(value, summary = {}) {
  const diagnosis = value || fallbackRunDiagnosis(summary);
  state.lastRunDiagnosis = diagnosis;
  $('#run-diagnosis-title').textContent = diagnosis.title || 'Some items could not be completed';
  $('#run-diagnosis-progress').textContent = (
    diagnosis.completed != null && diagnosis.total != null
      ? `${diagnosis.completed} completed, ${diagnosis.total - diagnosis.completed} need attention.`
      : summary.detail || 'The run needs attention.'
  );
  $('#run-diagnosis-cause').textContent = diagnosis.likelyCause?.label || 'Completion could not be verified';
  $('#run-diagnosis-confidence').textContent = `${Math.round(Number(diagnosis.likelyCause?.confidence || 0) * 100)}% confidence`;
  $('#run-diagnosis-explanation').textContent = diagnosis.likelyCause?.explanation || summary.detail || '';

  const evidence = diagnosis.evidence || [];
  $('#run-diagnosis-evidence-wrap').hidden = evidence.length === 0;
  appendTextItems('#run-diagnosis-evidence', evidence);

  const targets = $('#run-diagnosis-targets');
  targets.innerHTML = '';
  for (const target of diagnosis.affectedTargets || []) {
    const row = document.createElement('div');
    row.className = 'diagnosis-target';
    row.innerHTML = '<span class="diagnosis-target-title"></span><span class="diagnosis-target-reason"></span>';
    row.querySelector('.diagnosis-target-title').textContent = target.title || 'Unknown item';
    row.querySelector('.diagnosis-target-reason').textContent = target.diagnosis || target.reason || 'Needs review';
    targets.appendChild(row);
  }
  if (!targets.children.length) {
    const row = document.createElement('div');
    row.className = 'diagnosis-target';
    row.innerHTML = '<span class="diagnosis-target-title">See the run output for affected items.</span>';
    targets.appendChild(row);
  }
  appendTextItems(
    '#run-diagnosis-recommendations',
    diagnosis.recommendations,
    'Review the Learning queue, resolve the blocker, and run Auto-detect again.',
  );
  $('#run-diagnosis').hidden = false;
  $('#run-diagnosis-done').focus();
}

function closeRunDiagnosis() {
  $('#run-diagnosis').hidden = true;
}

$('#run-diagnosis-close').addEventListener('click', closeRunDiagnosis);
$('#run-diagnosis-done').addEventListener('click', closeRunDiagnosis);
$('#run-diagnosis-learning').addEventListener('click', () => {
  closeRunDiagnosis();
  showView('learning');
});
$('#run-diagnosis').addEventListener('click', (event) => {
  if (event.target.id === 'run-diagnosis') closeRunDiagnosis();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#run-diagnosis').hidden) closeRunDiagnosis();
});

// Inline task-progress indicator, embedded in the topbar. It shows only while a
// task runs and finalises to a ✓/✕ state when the run ends.
function showFloatingProgress(title, script) {
  const el = $('#task-progress');
  if (state.fpHideTimer) { clearTimeout(state.fpHideTimer); state.fpHideTimer = null; }
  state.fp = { label: title, script, total: null, current: 0, done: 0, ready: false };
  $('#tp-icon').className = 'tp-icon tp-spin';
  $('#tp-label').textContent = title;
  const bar = $('#tp-bar');
  bar.hidden = false;
  bar.className = 'tp-bar indeterminate';
  $('#tp-fill').style.width = '';
  $('#tp-fill').style.background = '';
  $('#tp-count').textContent = '';
  el.hidden = false;
}

// Parse the live run output for batch progress markers so the bar actually moves.
function updateFloatingFromOutput() {
  const fp = state.fp;
  if (!fp) return;
  const text = state.currentOutput || '';

  // Long-lived daemon scripts: finalise to success once the ready marker prints,
  // since the process stays alive by design and will never emit an "end".
  const daemon = fp.script && DAEMON_READY[fp.script];
  if (daemon && !fp.ready && daemon.pattern.test(text)) {
    fp.ready = true;
    state.daemonReady = fp.script;
    $('#output-status').textContent = 'ready (running)';
    finishFloatingProgress('success', daemon.title);
    showBanner('success', daemon.title, daemon.detail);
    // The browser is up now — refresh CDP status and the tab list.
    setTimeout(() => { loadCdp(); loadTabs(); }, 500);
    return;
  }

  const totalM = text.match(/Will attempt (\d+) courses?/i);
  if (totalM) fp.total = +totalM[1];

  // cert-batch prints "=== [X/Y] (ACTION) title ===" per course.
  const steps = [...text.matchAll(/===\s*\[(\d+)\/(\d+)\]/g)];
  if (steps.length) {
    const last = steps[steps.length - 1];
    fp.current = +last[1];
    fp.total = +last[2];
  }

  // container-batch prints "Activity X/Y" style markers.
  const act = [...text.matchAll(/[Aa]ctivity\s+(\d+)\s*\/\s*(\d+)/g)];
  if (act.length) {
    const last = act[act.length - 1];
    fp.current = +last[1];
    fp.total = +last[2];
  }

  // Count confirmed completions so the bar advances as items finish.
  const okMarks = (text.match(/post-state:[^\n]*\bOK\b/g) || []).length;
  if (okMarks) fp.done = okMarks;

  if (fp.total) {
    const numerator = Math.max(fp.done, fp.current > 0 ? fp.current - 1 : 0);
    const pct = Math.min(100, Math.round((numerator / fp.total) * 100));
    $('#tp-bar').classList.remove('indeterminate');
    $('#tp-fill').style.width = `${pct}%`;
    $('#tp-count').textContent = `${Math.min(fp.current || numerator, fp.total)}/${fp.total}`;
  }
}

// Called when a run ends: fill to 100% and show a ✓/✕ verdict, then auto-hide.
function finishFloatingProgress(level, title) {
  const fp = state.fp;
  if (!fp) return;
  const el = $('#task-progress');
  const ok = level === 'success';
  const warn = level === 'warn';
  $('#tp-icon').className = 'tp-icon ' + (ok ? 'tp-ok' : warn ? 'tp-warn' : 'tp-fail');
  $('#tp-icon').textContent = ok ? '\u2713' : warn ? '\u26a0' : '\u2715';
  $('#tp-label').textContent = title || (ok ? 'Done' : warn ? 'Needs review' : 'Failed');
  const bar = $('#tp-bar');
  bar.classList.remove('indeterminate');
  $('#tp-fill').style.width = '100%';
  $('#tp-fill').style.background = ok ? 'var(--green)' : warn ? 'var(--yellow, #d8a72e)' : 'var(--red, #f85149)';
  if (state.fpHideTimer) clearTimeout(state.fpHideTimer);
  state.fpHideTimer = setTimeout(() => { el.hidden = true; state.fp = null; }, 6000);
}

function hideFloatingProgress() {
  if (state.fpHideTimer) { clearTimeout(state.fpHideTimer); state.fpHideTimer = null; }
  $('#task-progress').hidden = true;
  state.fp = null;
}

$('#output-cancel').addEventListener('click', async () => {
  if (!state.activeRunId) return;
  try { await api(`/api/runs/${state.activeRunId}/kill`, { method: 'POST' }); } catch {}
});
$('#output-toggle').addEventListener('click', () => {
  const p = $('#output-panel');
  p.classList.toggle('collapsed');
  $('#output-toggle').textContent = p.classList.contains('collapsed') ? 'Show' : 'Hide';
});

// Cursor-style drag-to-resize on the output panel.
(function initResizer() {
  const resizer = $('#output-resizer');
  const outBody = $('#output-body');
  let startY = 0;
  let startH = 0;

  function onMove(e) {
    const delta = startY - e.clientY; // drag up => taller
    const h = Math.max(80, Math.min(window.innerHeight * 0.8, startH + delta));
    outBody.style.height = `${h}px`;
  }
  function onUp() {
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  resizer.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = outBody.getBoundingClientRect().height;
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
})();

// ---- Loaders -------------------------------------------------------------

async function loadCdp() {
  const dot = $('#cdp-dot');
  const label = $('#cdp-label');
  try {
    const { ok } = await api('/api/cdp');
    state.cdpUp = !!ok;
    dot.className = `dot ${ok ? 'dot-up' : 'dot-down'}`;
    label.textContent = ok ? 'CDP: connected' : 'CDP: offline';
  } catch {
    state.cdpUp = false;
    dot.className = 'dot dot-down';
    label.textContent = 'CDP: offline';
  }
}

async function loadTabs() {
  const box = $('#tabs-list');
  try {
    const tabs = await api('/api/tabs');
    if (!Array.isArray(tabs)) {
      box.innerHTML = '<p class="muted">Could not read tabs. Is the CDP browser running? (Start CDP browser)</p>';
      $('#tabs-count').textContent = '';
      return;
    }
    state.tabs = tabs;
    if (!tabs.some((tab) => tab.idx === state.selectedTabIdx)) {
      const isLearningTab = (tab) => /sabacloud|content-na2prd|login3\.id\.hp\.com/i.test(tab.url);
      const preferred = tabs.find((tab) => tab.hasFocus && isLearningTab(tab)) ||
        tabs.find((tab) => tab.visibilityState === 'visible' && isLearningTab(tab)) ||
        tabs.find(isLearningTab) ||
        tabs.find((tab) => tab.hasFocus) ||
        tabs[0];
      state.selectedTabIdx = preferred?.idx ?? null;
    }
    $('#tabs-count').textContent = `(${tabs.length})`;
    if (!tabs.length) { box.innerHTML = '<p class="muted">No tabs.</p>'; return; }
    box.innerHTML = '';
    for (const t of tabs) {
      const row = document.createElement('div');
      row.className = `tab-row${t.idx === state.selectedTabIdx ? ' selected' : ''}`;
      row.innerHTML = `
        <span class="tab-idx"></span>
        <div class="tab-info"><div class="tab-title"></div><div class="tab-url"></div></div>
        <button class="btn btn-ghost btn-sm">Fit</button>`;
      row.querySelector('.tab-idx').textContent = t.idx;
      row.querySelector('.tab-title').textContent = t.title || '(untitled)';
      row.querySelector('.tab-url').textContent = t.url;
      row.addEventListener('click', () => {
        state.selectedTabIdx = t.idx;
        loadTabs();
      });
      row.querySelector('button').addEventListener('click', (event) => {
        event.stopPropagation();
        state.selectedTabIdx = t.idx;
        runScript('pw-fit-tab.js', [String(t.idx)], `Fit tab ${t.idx}`);
      });
      box.appendChild(row);
    }
    loadRecentUrls();
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not read tabs (${e.message}). Is CDP up?</p>`;
    $('#tabs-count').textContent = '';
  }
}

async function loadRecentUrls() {
  const box = $('#recent-urls-list');
  const count = $('#recent-urls-count');
  try {
    const rows = await api('/api/recent-urls');
    if (!Array.isArray(rows) || !rows.length) {
      box.innerHTML = '<p class="muted">None yet. URLs are remembered as tabs are listed.</p>';
      count.textContent = '';
      return;
    }
    count.textContent = `(${rows.length})`;
    box.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      row.innerHTML = `
        <div class="recent-info"><div class="recent-title"></div><div class="recent-url"></div></div>
        <button class="btn btn-ghost btn-sm recent-open">Open</button>
        <button class="btn btn-ghost btn-sm recent-forget" title="Forget this URL">&times;</button>`;
      row.querySelector('.recent-title').textContent = r.title || '(untitled)';
      row.querySelector('.recent-url').textContent = r.url;
      row.querySelector('.recent-open').addEventListener('click', () =>
        runScript('pw-open-url.js', [r.url], `Open ${r.title || r.url}`, 'tabs'));
      row.querySelector('.recent-forget').addEventListener('click', async () => {
        try {
          await api('/api/recent-urls/forget', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.url }),
          });
          loadRecentUrls();
        } catch {}
      });
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load recent URLs (${e.message}).</p>`;
    count.textContent = '';
  }
}

// Launch an arbitrary URL in the CDP browser.
$('#launch-url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#launch-url-input');
  let url = (input.value || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  runScript('pw-open-url.js', [url], `Open ${url}`, 'tabs');
  input.value = '';
});

// End session: aggregate the session, write artifacts, close the browser, and
// show the wrap-up overlay.
$('#end-session-btn').addEventListener('click', async () => {
  let preview = null;
  try { preview = await api('/api/session/report'); } catch {}
  const c = preview && preview.counts;
  const msg = c
    ? `End this session?\n\n${c.coursesPassed} course(s) and ${c.activitiesPassed} activity(ies) completed, ${c.needsReview} need review.\n\nThis writes a session recap, updates history, and closes the browser.`
    : 'End this session? This writes a session recap, updates history, and closes the browser.';
  if (!confirm(msg)) return;

  const btn = $('#end-session-btn');
  btn.disabled = true;
  showSessionEnd(null, 'Ending session…');
  try {
    const r = await api('/api/session/end', { method: 'POST' });
    if (r && r.ok) {
      showSessionEnd(r.report, 'Session summary written and browser closed.', r.files);
    } else {
      showSessionEnd(preview, `Ended with a problem: ${(r && r.error) || 'unknown'}`);
    }
  } catch (e) {
    showSessionEnd(preview, `Could not end cleanly: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

function showSessionEnd(report, subtitle, files) {
  const el = $('#session-end');
  $('#session-end-sub').textContent = subtitle || '';
  const summaryBox = $('#session-end-summary');
  const reviewBox = $('#session-end-review');
  const filesBox = $('#session-end-files');

  if (report && report.counts) {
    const c = report.counts;
    summaryBox.innerHTML = `
      <div class="stat"><span class="stat-num">${c.coursesPassed}</span><span class="stat-lbl">courses passed</span></div>
      <div class="stat"><span class="stat-num">${c.activitiesPassed}</span><span class="stat-lbl">activities passed</span></div>
      <div class="stat"><span class="stat-num">${c.needsReview}</span><span class="stat-lbl">need review</span></div>`;
    if (report.anomalies && report.anomalies.length) {
      reviewBox.hidden = false;
      reviewBox.innerHTML = '<h3>Needs manual review next time</h3><ul>' +
        report.anomalies.map((a) => `<li><strong>${escapeHtml(a.title)}</strong> — ${escapeHtml(a.issue)}</li>`).join('') +
        '</ul>';
    } else {
      reviewBox.hidden = false;
      reviewBox.innerHTML = '<p class="muted">Clean session — nothing flagged for review.</p>';
    }
  } else {
    summaryBox.innerHTML = '';
    reviewBox.hidden = true;
  }

  if (files && files.length) {
    filesBox.innerHTML = '<span class="muted">Written:</span> ' +
      files.map((f) => `<code>${escapeHtml(f)}</code>`).join(' ');
  } else {
    filesBox.innerHTML = '';
  }
  el.hidden = false;
}

// End (close) the CDP browser.
$('#end-browser-btn').addEventListener('click', async () => {
  if (!confirm('Close the automation browser? Any un-saved automation tabs will be lost.')) return;
  const btn = $('#end-browser-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/cdp/stop', { method: 'POST' });
    showBanner(r && r.ok ? 'success' : 'warn',
      r && r.ok ? 'CDP browser closed' : 'Could not confirm close',
      r && r.method ? `method: ${r.method}` : '');
  } catch (e) {
    showBanner('error', 'Failed to close browser', e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { loadCdp(); loadTabs(); }, 800);
  }
});

function statusBadgeClass(status) {
  return 'badge-' + String(status || 'Unknown').replace(/\s+/g, '');
}

async function loadCert() {
  const box = $('#cert-roster');
  try {
    const cert = await api('/api/cert');
    if (cert && cert.error) {
      $('#cert-name').textContent = 'No certification tab open';
      box.innerHTML = '<p class="muted">Could not read certification. Is the CDP browser running?</p>';
      return;
    }
    state.cert = cert;
    if (!cert || !cert.certId) {
      $('#cert-name').textContent = 'No certification tab open';
      box.innerHTML = '<p class="muted">No <code>ledetail</code> tab detected. Open a certification page in the browser and hit Refresh.</p>';
      return;
    }
    $('#cert-name').textContent = cert.certTitle || cert.certId;
    let html = '';
    const courses = cert.courses || [];
    if (!courses.length) {
      html += '<p class="muted">No courses parsed.</p>';
    } else {
      for (const c of courses) {
        html += `<div class="course-row">
          <span class="course-title">${escapeHtml(c.title)}</span>
          <span class="badge ${statusBadgeClass(c.status)}">${escapeHtml(c.status)}</span>
        </div>`;
      }
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not read certification (${e.message}).</p>`;
  }
}

function historyResultClass(result) {
  const r = String(result || '').toLowerCase();
  if (/pass|acquir|complet/.test(r)) return 'hist-ok';
  if (/review|unknown|fail|below|err/.test(r)) return 'hist-warn';
  return '';
}

async function loadHistory() {
  const box = $('#history-table');
  try {
    const rows = await api('/api/history');
    if (!Array.isArray(rows) || !rows.length) { box.innerHTML = '<p class="muted">No history yet.</p>'; return; }
    // Already sorted newest-first by the server.
    let html = '<table><thead><tr><th>Date</th><th>Type</th><th>Item</th><th>Result</th><th>Detail</th></tr></thead><tbody>';
    for (const r of rows) {
      const date = String(r.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
      html += `<tr>
        <td class="hist-date">${escapeHtml(date)}</td>
        <td><span class="badge badge-kind-${escapeHtml(r.kind || '')}">${escapeHtml(r.kind || '')}</span></td>
        <td>${escapeHtml(r.title || '')}</td>
        <td class="${historyResultClass(r.result)}">${escapeHtml(r.result || '')}</td>
        <td class="hist-detail">${escapeHtml(r.detail || '')}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load history (${e.message}).</p>`;
  }
}

async function loadLearning() {
  const summaryBox = $('#learning-summary');
  const strategiesBox = $('#learning-strategies');
  const reviewsBox = $('#learning-reviews');
  try {
    const learning = await api('/api/learning');
    const counts = learning.counts || {};
    summaryBox.innerHTML = `
      <div class="learning-cards">
        <div class="learning-stat"><strong>${Number(counts.promoted || 0)}</strong><span>Promoted strategies</span></div>
        <div class="learning-stat"><strong>${Number(counts.candidates || 0)}</strong><span>Candidates</span></div>
        <div class="learning-stat"><strong>${Number(counts.needsReview || 0)}</strong><span>Regressions</span></div>
        <div class="learning-stat"><strong>${Number(counts.openReviews || 0)}</strong><span>Open reviews</span></div>
      </div>
      <p class="muted">Promotion threshold: ${Number(learning.thresholds?.verifiedSuccesses || 3)} verified successes across ${Number(learning.thresholds?.distinctTargets || 2)} distinct targets.</p>`;

    const strategies = learning.strategies || [];
    strategiesBox.innerHTML = '<h3>Strategies</h3>';
    const strategyList = document.createElement('div');
    strategyList.className = 'learning-list';
    for (const strategy of strategies.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'learning-row';
      row.innerHTML = `
        <div class="learning-row-main">
          <div class="learning-row-title"></div>
          <small></small>
        </div>
        <span class="badge"></span>`;
      row.querySelector('.learning-row-title').textContent = strategy.capabilityId;
      row.querySelector('small').textContent = `${strategy.successes} success(es), ${strategy.failures} failure(s), ${strategy.targets.length} target(s)`;
      row.querySelector('.badge').textContent = strategy.status;
      strategyList.appendChild(row);
    }
    if (!strategies.length) strategyList.innerHTML = '<p class="muted">No strategy observations yet.</p>';
    strategiesBox.appendChild(strategyList);

    const reviews = learning.reviews || [];
    reviewsBox.innerHTML = '<h3>Review queue</h3>';
    const reviewList = document.createElement('div');
    reviewList.className = 'learning-list';
    for (const review of reviews.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'learning-row';
      row.innerHTML = `
        <div class="learning-row-main">
          <div class="learning-row-title"></div>
          <small></small>
        </div>
        <span class="badge"></span>
        <button class="btn btn-ghost btn-sm">Resolve</button>`;
      row.querySelector('.learning-row-title').textContent = review.title;
      row.querySelector('small').textContent = review.nextAction || review.detail || review.artifact || review.fingerprint || '';
      row.querySelector('.badge').textContent = review.type;
      row.querySelector('button').addEventListener('click', async () => {
        await api(`/api/learning/reviews/${encodeURIComponent(review.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Resolved from Learning view.' }),
        });
        loadLearning();
      });
      reviewList.appendChild(row);
    }
    if (!reviews.length) reviewList.innerHTML = '<p class="muted">No open reviews.</p>';
    reviewsBox.appendChild(reviewList);
  } catch (error) {
    summaryBox.innerHTML = `<p class="muted">Could not load learning state (${escapeHtml(error.message)}).</p>`;
  }
}

// ---- Docs (inline markdown) ----------------------------------------------

let currentDoc = 'AGENTS.md';
$$('.doc-item').forEach((b) => b.addEventListener('click', () => {
  currentDoc = b.dataset.doc;
  $$('.doc-item').forEach((x) => x.classList.toggle('active', x === b));
  loadDoc(currentDoc);
}));

async function loadDoc(name) {
  const box = $('#doc-body');
  try {
    const { content } = await api(`/api/docs?name=${encodeURIComponent(name)}`);
    box.innerHTML = renderMarkdown(content);
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load ${escapeHtml(name)} (${e.message}).</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal but sufficient markdown -> HTML. Handles headings, fenced code,
// tables, lists, blockquotes, inline code, bold, links, paragraphs.
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;

  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      i++;
      let code = '';
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++; // closing fence
      html += `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }

    // blockquote (consume consecutive)
    if (/^>\s?/.test(line)) {
      let q = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) { q += inline(lines[i].replace(/^>\s?/, '')) + '<br>'; i++; }
      html += `<blockquote>${q}</blockquote>`;
      continue;
    }

    // table: header row + separator row of dashes
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const parseRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = parseRow(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        const cells = parseRow(lines[i]);
        rows += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
      continue;
    }

    // unordered list (consume consecutive)
    if (/^\s*[-*]\s+/.test(line)) {
      let items = '';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`;
        i++;
      }
      html += `<ul>${items}</ul>`;
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      let items = '';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`;
        i++;
      }
      html += `<ol>${items}</ol>`;
      continue;
    }

    // blank
    if (!line.trim()) { i++; continue; }

    // paragraph (consume until blank or block starter)
    let para = '';
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      para += (para ? ' ' : '') + lines[i];
      i++;
    }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}

// ---- Boot ----------------------------------------------------------------

$('#refresh-btn').addEventListener('click', () => { loadCdp(); loadTabs(); loadCert(); loadRecentUrls(); });

loadCapabilities();
loadCdp();
loadTabs();
loadCert();
loadRecentUrls();

// Light polling for CDP + tabs so the dashboard stays current. Only poll tabs
// when CDP is up (each poll spawns a Playwright process) and the dashboard view
// is active, to avoid needless churn while the browser is closed.
setInterval(loadCdp, 8000);
setInterval(() => {
  if (state.cdpUp && $('#view-dashboard').classList.contains('active')) loadTabs();
}, 12000);
