// lib/run-diagnosis.js
//
// Converts executor evidence into a user-facing root-cause hypothesis. The
// diagnosis is persisted with the attempt and sent to the dashboard failure
// modal; it never invents a successful completion from an exit code alone.

function parseAutomationResult(output = '') {
  const matches = [...String(output).matchAll(/^AUTOMATION_RESULT\s+(.+)$/gm)];
  if (!matches.length) return null;
  try { return JSON.parse(matches[matches.length - 1][1]); } catch { return null; }
}

function parseFallbackFailures(output = '') {
  const failures = [];
  const text = String(output);
  const section = text.split('Needs manual review:')[1] || '';
  for (const line of section.split('\n')) {
    const match = line.match(/^\s*-\s+(.+?):\s+([a-z0-9-]+)\s*$/i);
    if (match) failures.push({ title: match[1].trim(), reason: match[2].toLowerCase(), evidence: [] });
  }
  for (const match of text.matchAll(/^\s*FAIL\s+(.+?)\s+\(([^)]+)\)\s*$/gmi)) {
    if (!failures.some((failure) => failure.title === match[1].trim())) {
      failures.push({ title: match[1].trim(), reason: match[2].trim().toLowerCase(), evidence: [] });
    }
  }
  return failures;
}

function reasonDetails(reason) {
  const normalized = String(reason || 'unknown').toLowerCase();
  if (normalized === 'prerequisites-incomplete') {
    return {
      code: normalized,
      label: 'Required prerequisites are incomplete',
      confidence: 0.99,
      explanation: 'Saba has locked the selected courses. Their controls remain VIEW instead of LAUNCH until the prerequisite modules and required sequence progress are complete.',
      recommendation: 'Complete the prerequisite certification modules first, then run Auto-detect again. The unlocked course actions should change from VIEW to LAUNCH.',
    };
  }
  if (normalized === 'nested-learning-requirement') {
    return {
      code: normalized,
      label: 'The selection is a nested learning requirement',
      confidence: 0.96,
      explanation: 'The selected row opens another certification or class rather than a SCORM player, so it needs its own detection and completion plan.',
      recommendation: 'Open the nested requirement, use Auto-detect there, and complete its unfinished items before returning to this certification.',
    };
  }
  if (normalized === 'view-page-has-no-launch') {
    return {
      code: normalized,
      label: 'Saba opened a details page with no launch action',
      confidence: 0.9,
      explanation: 'The selected VIEW action did not expose a SCORM player. Registration, prerequisites, or another requirement on the details page is preventing launch.',
      recommendation: 'Review the linked details page for registration or prerequisite requirements, satisfy them, then retry Auto-detect.',
    };
  }
  if (normalized === 'button-not-found') {
    return {
      code: normalized,
      label: 'The Saba roster changed while the batch was running',
      confidence: 0.85,
      explanation: 'A selected action disappeared during an Angular re-render, usually after another course changed the roster state.',
      recommendation: 'Refresh the certification roster and rerun Auto-detect for the remaining items.',
    };
  }
  if (/no-player|no-api/.test(normalized)) {
    return {
      code: normalized,
      label: 'No supported course player appeared',
      confidence: 0.82,
      explanation: 'The action did not open a SCORM or known assessment player, so the batch could not safely change completion state.',
      recommendation: 'Open one affected item manually and use Capture page for learning so its launch behavior can be classified.',
    };
  }
  if (/timeout/.test(normalized)) {
    return {
      code: normalized,
      label: 'The learning page did not become ready in time',
      confidence: 0.8,
      explanation: 'The expected player or completion signal did not appear before the safety timeout.',
      recommendation: 'Check the browser session and network, then retry the remaining items.',
    };
  }
  return {
    code: normalized,
    label: 'The completion result could not be verified',
    confidence: 0.65,
    explanation: 'The run ended without enough evidence to confirm that every selected item completed.',
    recommendation: 'Review the affected items and linked evidence in Learning, then rerun Auto-detect.',
  };
}

function diagnoseRun({ script, code, output = '', outcome = null }) {
  const structured = parseAutomationResult(output);
  const summaryMatch = String(output).match(/(\d+)\/(\d+)\s+confirmed (?:Successful|complete)/i);
  const completed = structured?.completed ?? (summaryMatch ? Number(summaryMatch[1]) : null);
  const total = structured?.total ?? (summaryMatch ? Number(summaryMatch[2]) : null);
  const failures = structured?.failures?.length
    ? structured.failures
    : parseFallbackFailures(output);
  const unsuccessful = (
    outcome?.outcome === 'failure' ||
    code !== 0 ||
    failures.length > 0 ||
    (total != null && completed != null && completed < total)
  );
  if (!unsuccessful) return null;

  const enriched = failures.map((failure) => ({
    ...failure,
    diagnosis: reasonDetails(failure.reason || outcome?.failureSignature),
  }));
  const counts = new Map();
  for (const failure of enriched) {
    const code = failure.diagnosis.code;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const primaryCode = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ||
    outcome?.failureSignature ||
    `exit-${code}`;
  const primary = reasonDetails(primaryCode);
  const evidence = [...new Set(enriched.flatMap((failure) => failure.evidence || []))].slice(0, 8);
  const artifacts = [...new Set(enriched.map((failure) => failure.artifact).filter(Boolean))];
  const progress = completed != null && total != null ? `${completed} of ${total}` : 'Not all';

  return {
    schemaVersion: 1,
    severity: code === 0 ? 'warning' : 'error',
    title: `${progress} selected item${total === 1 ? '' : 's'} completed`,
    script,
    completed,
    total,
    likelyCause: primary,
    evidence,
    affectedTargets: enriched.map((failure) => ({
      title: failure.title,
      reason: failure.reason,
      diagnosis: failure.diagnosis.label,
      artifact: failure.artifact || null,
    })),
    recommendations: [...new Set([
      primary.recommendation,
      'After resolving the blocker, rerun Auto-detect so the roster and action plan are rebuilt from current state.',
    ])],
    artifacts,
  };
}

module.exports = {
  diagnoseRun,
  parseAutomationResult,
  reasonDetails,
};
