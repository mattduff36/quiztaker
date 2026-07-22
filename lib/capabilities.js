// lib/capabilities.js
//
// Single source of truth for dashboard capabilities, runnable scripts, safety
// policy, and verification metadata. Detection, the server whitelist, and the
// dashboard all consume this registry.

const CAPABILITIES = [
  {
    id: 'start-browser',
    version: 1,
    script: 'start-cdp-browser.js',
    label: 'Start CDP browser',
    description: 'Launch Chromium with remote debugging on port 9222.',
    risk: 'low',
    mutatesCourse: false,
    card: true,
    refreshAfter: 'tabs',
    verifier: 'cdp-connected',
  },
  {
    id: 'list-tabs',
    version: 1,
    script: 'pw-list-tabs.js',
    label: 'List tabs',
    description: 'Refresh the tabs in the attached browser.',
    risk: 'none',
    mutatesCourse: false,
    card: true,
    refreshAfter: 'tabs',
    verifier: 'process-exit',
  },
  {
    id: 'fit-tab',
    version: 1,
    script: 'pw-fit-tab.js',
    label: 'Fit tab',
    description: 'Fit a selected tab to its browser window.',
    risk: 'none',
    mutatesCourse: false,
    verifier: 'process-exit',
  },
  {
    id: 'cert-status',
    version: 1,
    script: 'pw-cert-status.js',
    label: 'Certification status',
    description: 'Read the current certification roster.',
    risk: 'none',
    mutatesCourse: false,
    card: true,
    refreshAfter: 'cert',
    verifier: 'process-exit',
  },
  {
    id: 'cert-batch',
    version: 2,
    script: 'pw-cert-batch.js',
    label: 'Complete selected certification courses',
    description: 'Fast-complete selected unfinished courses on a certification.',
    risk: 'medium',
    mutatesCourse: true,
    dryRunArgs: ['--dry'],
    card: true,
    picker: 'cert-courses',
    refreshAfter: 'cert',
    verifier: 'cert-roster-successful',
  },
  {
    id: 'cert-dry-run',
    version: 1,
    script: 'pw-cert-batch.js',
    args: ['--dry'],
    label: 'Dry-run certification',
    description: 'Show which certification courses would be attempted.',
    risk: 'none',
    mutatesCourse: false,
    card: true,
    verifier: 'process-exit',
  },
  {
    id: 'class-batch',
    version: 1,
    script: 'pw-class-batch.js',
    label: 'Complete selected class activities',
    description: 'Complete selected unfinished activities on a class detail page.',
    risk: 'medium',
    mutatesCourse: true,
    dryRunArgs: ['--dry'],
    picker: 'class-activities',
    refreshAfter: 'tabs',
    verifier: 'class-activity-completed',
  },
  {
    id: 'scorm-complete',
    version: 2,
    script: 'pw-scorm-complete.js',
    label: 'Complete active SCORM content',
    description: 'Set passed and score 100 through the SCORM 1.2 or 2004 API.',
    risk: 'medium',
    mutatesCourse: true,
    dryRunArgs: ['--dry'],
    card: true,
    refreshAfter: 'cert',
    verifier: 'scorm-commit-and-status',
  },
  {
    id: 'container-batch',
    version: 3,
    script: 'pw-container-batch.js',
    label: 'Complete container activities',
    description: 'Complete every unfinished SCORM activity in the current container.',
    risk: 'medium',
    mutatesCourse: true,
    dryRunArgs: ['--dry'],
    card: true,
    refreshAfter: 'cert',
    verifier: 'container-activities-completed',
  },
  {
    id: 'slickquiz-solve',
    version: 1,
    script: 'pw-slickquiz-solve.js',
    label: 'Solve SlickQuiz from embedded key',
    description: 'Use the embedded quizJSON answer key and verify completion.',
    risk: 'high',
    mutatesCourse: true,
    dryRunArgs: ['--dry'],
    verifier: 'quiz-result-passed',
  },
  {
    id: 'learn-capture',
    version: 2,
    script: 'pw-learn-capture.js',
    label: 'Capture page for learning',
    description: 'Save a normalized fingerprint, screenshot, text, DOM, and frame probes.',
    risk: 'none',
    mutatesCourse: false,
    card: true,
    verifier: 'capture-written',
  },
  {
    id: 'tab-inspect',
    version: 1,
    script: 'pw-tab-inspect.js',
    label: 'Inspect tab',
    description: 'Capture a read-only tab screenshot and text dump.',
    risk: 'none',
    mutatesCourse: false,
    verifier: 'capture-written',
  },
  {
    id: 'cdp-check',
    version: 1,
    script: 'pw-cdp-check.js',
    label: 'Check browser connection',
    description: 'Check whether the CDP browser is connected.',
    risk: 'none',
    mutatesCourse: false,
    verifier: 'process-exit',
  },
  {
    id: 'detect',
    version: 2,
    script: 'pw-detect.js',
    label: 'Detect current learning context',
    description: 'Probe the selected tab and build a ranked action plan.',
    risk: 'none',
    mutatesCourse: false,
    verifier: 'process-exit',
  },
  {
    id: 'close-browser',
    version: 1,
    script: 'pw-close-browser.js',
    label: 'Close CDP browser',
    description: 'Close the attached automation browser.',
    risk: 'low',
    mutatesCourse: false,
    verifier: 'process-exit',
  },
  {
    id: 'open-url',
    version: 1,
    script: 'pw-open-url.js',
    label: 'Open URL',
    description: 'Open a URL in a new browser tab.',
    risk: 'low',
    mutatesCourse: false,
    verifier: 'process-exit',
  },
];

const SAFE_ACTIONS = new Set([
  'probe',
  'click',
  'launch',
  'wait',
  'scroll',
  'scorm-complete',
  'answer-select',
  'exit',
  'verify',
  'capture',
]);

function getCapability(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}

function getCapabilityForRun(script, args = []) {
  const normalizedArgs = args.map(String);
  const matches = CAPABILITIES.filter((capability) => capability.script === script);
  return matches.find((capability) => (
    capability.args &&
    capability.args.length === normalizedArgs.length &&
    capability.args.every((arg, index) => arg === normalizedArgs[index])
  )) || matches.find((capability) => !capability.args) || null;
}

function isMutatingRun(script, args = []) {
  const normalizedArgs = args.map(String);
  const capability = getCapabilityForRun(script, normalizedArgs);
  if (!capability) return false;
  if (
    capability.dryRunArgs?.length &&
    capability.dryRunArgs.every((arg) => normalizedArgs.includes(arg))
  ) return false;
  return !!capability.mutatesCourse;
}

function listPublicCapabilities() {
  return CAPABILITIES.map((capability) => ({
    id: capability.id,
    version: capability.version,
    script: capability.script,
    label: capability.label,
    description: capability.description,
    args: capability.args || [],
    risk: capability.risk,
    mutatesCourse: capability.mutatesCourse,
    dryRunArgs: capability.dryRunArgs || [],
    card: !!capability.card,
    picker: capability.picker || null,
    refreshAfter: capability.refreshAfter || null,
    verifier: capability.verifier,
  }));
}

function createAction(capabilityId, options = {}) {
  const capability = getCapability(capabilityId);
  if (!capability) throw new Error(`Unknown capability: ${capabilityId}`);
  return {
    capabilityId,
    capabilityVersion: capability.version,
    label: options.label || capability.label,
    script: capability.script,
    args: options.args || capability.args || [],
    risk: options.risk || capability.risk,
    mutatesCourse: capability.mutatesCourse,
    verifier: capability.verifier,
    steps: options.steps || [],
    constraints: options.constraints || null,
  };
}

module.exports = {
  CAPABILITIES,
  SAFE_ACTIONS,
  createAction,
  getCapability,
  getCapabilityForRun,
  isMutatingRun,
  listPublicCapabilities,
};
