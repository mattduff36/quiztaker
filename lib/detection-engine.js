// lib/detection-engine.js
//
// Registry-driven detection and planning for the dashboard and CLI.

const { createAction } = require('./capabilities');
const { probePage } = require('./page-probe');
const { findPromotedStrategy, rankCandidate } = require('./learning-engine');
const { extractCertId, readCourseList, readCertMeta } = require('./cert-status');
const { readClassActivities, readClassMeta } = require('./class-status');

function actionPlan(action, options = {}) {
  if (!action) return null;
  return {
    capabilityId: action.capabilityId,
    capabilityVersion: action.capabilityVersion,
    label: action.label,
    script: action.script,
    args: action.args,
    risk: action.risk,
    mutatesCourse: action.mutatesCourse,
    verifier: action.verifier,
    steps: action.steps,
    constraints: action.constraints,
    targets: options.targets || [],
    confidence: options.confidence || 0,
    evidence: options.evidence || [],
  };
}

function classifyProbeSignals(probe) {
  if (probe.urlKind === 'session-dead') return { detected: 'session-dead', capabilityId: null };
  if (probe.urlKind === 'scorm-player' || probe.scorm) return { detected: 'scorm-player', capabilityId: 'scorm-complete' };
  if (probe.urlKind === 'content-player') {
    if (probe.hasSlickQuiz) return { detected: 'slickquiz-exam', capabilityId: 'slickquiz-solve' };
    if (probe.hasAssessmentShell) return { detected: 'server-assessment', capabilityId: 'learn-capture' };
    if (probe.hasActivityRows) return { detected: 'container', capabilityId: 'container-batch' };
    if (probe.hasDocumentContent) return { detected: 'document-wbt', capabilityId: 'learn-capture' };
    return { detected: 'unknown', capabilityId: 'learn-capture' };
  }
  if (probe.urlKind === 'cert-landing') return { detected: 'cert-landing', capabilityId: 'cert-batch' };
  if (probe.urlKind === 'class-detail') return { detected: 'class-detail', capabilityId: 'class-batch' };
  if (probe.urlKind === 'external-tool') return { detected: 'external-tool', capabilityId: 'learn-capture' };
  return { detected: 'none', capabilityId: null };
}

async function choosePage(ctx, preferredTabIdx) {
  const pages = ctx.pages();
  if (Number.isInteger(preferredTabIdx) && pages[preferredTabIdx]) {
    return { page: pages[preferredTabIdx], tabIdx: preferredTabIdx, reason: 'explicit-tab' };
  }

  const focusStates = await Promise.all(pages.map(async (page, tabIdx) => {
    const state = await page.evaluate(() => ({
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
    })).catch(() => ({ hasFocus: false, visibility: 'unknown' }));
    return { page, tabIdx, ...state };
  }));
  const focused = focusStates.find((entry) => entry.hasFocus);
  if (focused) return { ...focused, reason: 'focused-tab' };
  const visible = focusStates.find((entry) => entry.visibility === 'visible');
  if (visible) return { ...visible, reason: 'visible-tab' };

  const probes = await Promise.all(pages.map((page, tabIdx) => probePage(page, tabIdx)));
  const priority = ['scorm-player', 'content-player', 'cert-landing', 'class-detail', 'session-dead', 'external-tool'];
  for (const kind of priority) {
    const index = probes.findIndex((probe) => probe.urlKind === kind);
    if (index !== -1) return { page: pages[index], tabIdx: index, probe: probes[index], reason: 'fallback-priority' };
  }
  return pages[0] ? { page: pages[0], tabIdx: 0, probe: probes[0], reason: 'first-tab' } : null;
}

function resultBase(probe, detected, detail, confidence, evidence, action = null, selection = null) {
  const ranked = action
    ? rankCandidate(action.capabilityId, probe.fingerprint, confidence)
    : { confidence, evidence: null };
  const rankedEvidence = ranked.evidence ? [...evidence, ranked.evidence] : evidence;
  const plan = actionPlan(action, {
    confidence: ranked.confidence,
    evidence: rankedEvidence,
    targets: selection?.items || [],
  });
  return {
    detected,
    tabIdx: probe.tabIdx,
    title: probe.title,
    url: probe.url,
    fingerprint: probe.fingerprint,
    confidence: ranked.confidence,
    evidence: rankedEvidence,
    detail,
    selection,
    action,
    plan,
    probe,
  };
}

function argsForCapability(capabilityId, tabIdx) {
  if (capabilityId === 'slickquiz-solve') return ['--tab', String(tabIdx)];
  if (['scorm-complete', 'container-batch', 'class-batch', 'learn-capture'].includes(capabilityId)) {
    return [String(tabIdx)];
  }
  return [];
}

async function detectBrowser(ctx, preferredTabIdx = null) {
  if (!ctx || ctx.pages().length === 0) {
    return {
      detected: 'none',
      confidence: 1,
      evidence: ['No CDP pages are open.'],
      detail: 'No tabs open in the CDP browser.',
      action: null,
      plan: null,
    };
  }

  const chosen = await choosePage(ctx, preferredTabIdx);
  const probe = chosen.probe || await probePage(chosen.page, chosen.tabIdx);
  const classification = classifyProbeSignals(probe);
  const intentEvidence = `Selected by ${chosen.reason}.`;

  if (classification.detected === 'session-dead') {
    return resultBase(
      probe,
      'session-dead',
      'The Saba session has expired. Log in manually, then run Auto-detect again.',
      1,
      [intentEvidence, 'URL matches the HP identity login flow.'],
    );
  }

  if (classification.detected === 'scorm-player') {
    const kind = probe.scorm ? `SCORM ${probe.scorm}` : 'SCORM';
    const action = createAction('scorm-complete', {
      label: `Fast-complete this ${kind} course`,
      args: [String(probe.tabIdx)],
      steps: ['probe', 'scorm-complete', 'verify', 'exit'],
    });
    return resultBase(
      probe,
      'scorm-player',
      `A ${kind} player is ready to complete and verify.`,
      probe.scorm ? 0.99 : 0.86,
      [intentEvidence, `URL kind: ${probe.urlKind}.`, `SCORM API: ${probe.scorm || 'not yet visible'}.`],
      action,
    );
  }

  if (probe.urlKind === 'content-player') {
    if (classification.detected === 'slickquiz-exam') {
      const action = createAction('slickquiz-solve', {
        args: [String(probe.tabIdx)],
        steps: ['probe', 'answer-select', 'verify', 'exit'],
      });
      return resultBase(
        probe,
        'slickquiz-exam',
        'A SlickQuiz exam exposes an embedded answer key and can be solved automatically.',
        0.99,
        [intentEvidence, 'quizJSON.questions is present in an accessible frame.'],
        action,
      );
    }
    if (classification.detected === 'server-assessment') {
      const action = createAction('learn-capture', {
        label: 'Capture and analyze this server-scored assessment',
        args: [String(probe.tabIdx), '--detected=server-assessment'],
        risk: 'high',
        steps: ['probe', 'capture'],
        constraints: {
          submissionAuthorized: false,
          remainingAttempts: probe.assessment?.remainingAttempts ?? null,
          passingScore: probe.assessment?.passingScore ?? null,
        },
      });
      const q = probe.question ? ` Current question: ${probe.question.current}/${probe.question.total}.` : '';
      return resultBase(
        probe,
        'server-assessment',
        `A server-scored assessment needs the guarded quiz workflow.${q}`,
        0.95,
        [
          intentEvidence,
          'Assessment shell text or answer inputs were detected.',
          `Remaining attempts: ${probe.assessment?.remainingAttempts ?? 'unknown'}; passing score: ${probe.assessment?.passingScore ?? 'unknown'}.`,
          'No automatic submission is authorized by this capture plan.',
        ],
        action,
      );
    }
    if (classification.detected === 'container') {
      const action = createAction('container-batch', {
        args: [String(probe.tabIdx)],
        steps: ['probe', 'launch', 'scorm-complete', 'verify', 'exit'],
      });
      return resultBase(
        probe,
        'container',
        'A multi-activity container is ready to complete and verify.',
        0.97,
        [intentEvidence, 'Visible activity-list-item rows were detected.'],
        action,
      );
    }
    const promoted = findPromotedStrategy(probe.fingerprint);
    if (promoted && promoted.capabilityId !== 'learn-capture') {
      const action = createAction(promoted.capabilityId, {
        label: `Run learned ${promoted.capabilityId} strategy`,
        args: argsForCapability(promoted.capabilityId, probe.tabIdx),
        steps: promoted.actions,
      });
      return resultBase(
        probe,
        `learned-${promoted.capabilityId}`,
        `A promoted strategy matches this exact fingerprint and is ready for confirmed execution.`,
        0.9,
        [intentEvidence, `Promoted from ${promoted.successes} verified independent attempt(s).`],
        action,
      );
    }
    const action = createAction('learn-capture', {
      args: [String(probe.tabIdx), `--detected=${probe.hasDocumentContent ? 'document-wbt' : 'unknown'}`],
      steps: ['probe', 'capture'],
    });
    return resultBase(
      probe,
      probe.hasDocumentContent ? 'document-wbt' : 'unknown',
      probe.hasDocumentContent
        ? 'Document-style content was detected. Capture it to determine its completion trigger.'
        : 'This content-player does not match a promoted strategy. Capture it for guided learning.',
      probe.hasDocumentContent ? 0.78 : 0.5,
      [intentEvidence, `Fingerprint: ${probe.fingerprint}.`, 'No promoted mutating strategy matched.'],
      action,
    );
  }

  if (classification.detected === 'cert-landing') {
    const courses = await readCourseList(chosen.page).catch(() => []);
    const meta = await readCertMeta(chosen.page).catch(() => ({}));
    const remaining = courses.filter((course) => course.status !== 'Successful' && course.action !== 'CERT');
    const runnable = remaining.filter((course) => !course.isBlocked);
    const blocked = remaining.filter((course) => course.isBlocked);
    const certName = meta.certTitle || extractCertId(probe.url) || 'Certification';
    const selection = {
      kind: 'cert-courses',
      title: certName,
      tabIdx: probe.tabIdx,
      itemLabel: 'course',
      completedStatus: 'Successful',
      items: courses,
    };
    const action = runnable.length ? createAction('cert-batch', {
      label: `Complete selected courses from "${certName}"`,
      steps: ['probe', 'launch', 'scorm-complete', 'verify'],
    }) : null;
    return resultBase(
      probe,
      'cert-landing',
      remaining.length
        ? `"${certName}" has ${runnable.length} runnable and ${blocked.length} blocked unfinished course${remaining.length === 1 ? '' : 's'}.` +
          (blocked.length ? ' Blocked items require prerequisite or sequence progress first.' : '')
        : `"${certName}" has no unfinished courses.`,
      0.98,
      [
        intentEvidence,
        `${courses.length} roster rows were read.`,
        `${runnable.length} rows are runnable; ${blocked.length} are blocked.`,
        ...blocked.slice(0, 3).flatMap((course) => course.blockingEvidence?.slice(0, 1) || []),
      ],
      action,
      selection,
    );
  }

  if (classification.detected === 'class-detail') {
    const activities = await readClassActivities(chosen.page).catch(() => []);
    const meta = await readClassMeta(chosen.page).catch(() => ({}));
    const unfinished = activities.filter((activity) => activity.status !== 'Completed' && activity.action === 'LAUNCH');
    const className = meta.classTitle || probe.title || 'Current course';
    const selection = {
      kind: 'class-activities',
      title: className,
      tabIdx: probe.tabIdx,
      itemLabel: 'activity',
      completedStatus: 'Completed',
      items: activities,
    };
    const action = unfinished.length ? createAction('class-batch', {
      label: `Complete selected activities from "${className}"`,
      args: [String(probe.tabIdx)],
      steps: ['probe', 'launch', 'scorm-complete', 'verify', 'exit'],
    }) : null;
    return resultBase(
      probe,
      'class-detail',
      unfinished.length
        ? `"${className}" has ${unfinished.length} unfinished activit${unfinished.length === 1 ? 'y' : 'ies'}.`
        : `"${className}" has no unfinished activities.`,
      0.98,
      [intentEvidence, `${activities.length} activity rows were read.`, `${unfinished.length} rows are eligible.`],
      action,
      selection,
    );
  }

  if (classification.detected === 'external-tool') {
    const action = createAction('learn-capture', {
      label: 'Capture this external learning tool',
      args: [String(probe.tabIdx), '--detected=external-tool'],
      steps: ['probe', 'capture'],
    });
    return resultBase(
      probe,
      'external-tool',
      'An external learning tool is open. Capture its behavior before attempting completion.',
      0.82,
      [intentEvidence, `External-tool URL fingerprint: ${probe.host}${probe.path}.`],
      action,
    );
  }

  return resultBase(
    probe,
    'none',
    'The selected tab is not a recognized Saba learning context.',
    0.4,
    [intentEvidence, `URL kind: ${probe.urlKind}.`],
  );
}

module.exports = {
  actionPlan,
  classifyProbeSignals,
  choosePage,
  detectBrowser,
  resultBase,
};
