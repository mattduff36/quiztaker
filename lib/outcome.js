// lib/outcome.js
//
// Normalizes executor stdout/stderr into a verification outcome for the ledger
// and learning engine.

const { parseAutomationResult } = require('./run-diagnosis');

function classifyOutcome({ script, code, output = '' }) {
  const text = String(output);
  const capture = text.match(/"dir"\s*:\s*"([^"]+)"/i)?.[1]?.replace(/\\\\/g, '/');
  const structured = parseAutomationResult(text);
  const artifacts = [
    ...(capture ? [capture] : []),
    ...(structured?.failures || []).map((failure) => failure.artifact).filter(Boolean),
  ];

  if (code !== 0) {
    const signature = (
      text.match(/SCORM API not found|no-api|no-player-tab|button-not-found|TimeoutError|ECONNREFUSED/i)?.[0] ||
      `exit-${code}`
    ).toLowerCase();
    return { outcome: 'failure', verified: false, status: `exit ${code}`, failureSignature: signature, artifacts };
  }

  if (script === 'pw-learn-capture.js' && /"ok"\s*:\s*true/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'capture-written', artifacts };
  }
  if (structured) {
    const isComplete = structured.total > 0 && structured.completed === structured.total;
    const primaryReason = structured.failures?.[0]?.reason || 'partial-completion';
    return {
      outcome: isComplete ? 'success' : 'failure',
      verified: isComplete,
      status: `${structured.completed}/${structured.total} completed`,
      failureSignature: isComplete ? null : primaryReason,
      artifacts: [...new Set(artifacts)],
    };
  }
  if (/(\d+)\/\1\s+confirmed (?:Successful|complete)/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'all-targets-complete', artifacts };
  }
  if (
    /"lesson_status"\s*:\s*"passed"/i.test(text) ||
    (/"completion"\s*:\s*"completed"/i.test(text) && /"success"\s*:\s*"passed"/i.test(text))
  ) {
    return { outcome: 'success', verified: true, status: 'passed', artifacts };
  }
  if (/Dry run:|Will attempt \d+|Course roster:/i.test(text) && /--dry|Dry run:/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'dry-run', artifacts };
  }
  if (/Needs manual review:|FAIL|unconfirmed|not-found/i.test(text)) {
    const signature = text.match(/no-api|no-player-tab|button-not-found|unconfirmed|not-found/i)?.[0] || 'manual-review';
    return { outcome: 'failure', verified: false, status: 'needs-review', failureSignature: signature.toLowerCase(), artifacts };
  }
  return { outcome: 'success', verified: false, status: 'process-exit-0', artifacts };
}

module.exports = { classifyOutcome };
