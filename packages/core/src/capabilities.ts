import type { Capability } from './types.js';

export const capabilities: readonly Capability[] = [
  capability('start-browser', 1, 'start-cdp-browser.js', 'Start CDP browser', 'Launch Chrome with loopback remote debugging.', 'low', false, 'cdp-connected', { card: true, refreshAfter: 'tabs' }),
  capability('list-tabs', 1, 'pw-list-tabs.js', 'List tabs', 'Refresh tabs in the attached browser.', 'none', false, 'process-exit', { card: true, refreshAfter: 'tabs' }),
  capability('fit-tab', 1, 'pw-fit-tab.js', 'Fit tab', 'Fit a selected tab to its browser window.', 'none', false, 'process-exit'),
  capability('cert-status', 1, 'pw-cert-status.js', 'Certification status', 'Read the current certification roster.', 'none', false, 'process-exit', { card: true, refreshAfter: 'cert' }),
  capability('cert-batch', 2, 'pw-cert-batch.js', 'Complete selected certification courses', 'Complete selected unfinished certification courses.', 'medium', true, 'cert-roster-successful', { card: true, picker: 'cert-courses', refreshAfter: 'cert', dryRunArgs: ['--dry'] }),
  capability('cert-dry-run', 1, 'pw-cert-batch.js', 'Dry-run certification', 'Show which certification courses would be attempted.', 'none', false, 'process-exit', { card: true, args: ['--dry'] }),
  capability('class-batch', 1, 'pw-class-batch.js', 'Complete selected class activities', 'Complete selected unfinished class activities.', 'medium', true, 'class-activity-completed', { picker: 'class-activities', refreshAfter: 'tabs', dryRunArgs: ['--dry'] }),
  capability('scorm-complete', 2, 'pw-scorm-complete.js', 'Complete active SCORM content', 'Set passed and score 100 through the available SCORM API.', 'medium', true, 'scorm-commit-and-status', { card: true, refreshAfter: 'cert', dryRunArgs: ['--dry'] }),
  capability('container-batch', 3, 'pw-container-batch.js', 'Complete container activities', 'Complete unfinished SCORM activities in the current container.', 'medium', true, 'container-activities-completed', { card: true, refreshAfter: 'cert', dryRunArgs: ['--dry'] }),
  capability('slickquiz-solve', 1, 'pw-slickquiz-solve.js', 'Solve SlickQuiz from embedded key', 'Use the embedded quiz answer key and verify completion.', 'high', true, 'quiz-result-passed', { dryRunArgs: ['--dry'] }),
  capability('learn-capture', 2, 'pw-learn-capture.js', 'Capture page for learning', 'Save a normalized page capture for later review.', 'none', false, 'capture-written', { card: true }),
  capability('tab-inspect', 1, 'pw-tab-inspect.js', 'Inspect tab', 'Capture a read-only screenshot and text dump.', 'none', false, 'capture-written'),
  capability('cdp-check', 1, 'pw-cdp-check.js', 'Check browser connection', 'Check whether the CDP browser is connected.', 'none', false, 'process-exit'),
  capability('detect', 2, 'pw-detect.js', 'Detect current learning context', 'Probe the selected tab and build a ranked plan.', 'none', false, 'process-exit'),
  capability('close-browser', 1, 'pw-close-browser.js', 'Close CDP browser', 'Close the attached automation browser.', 'low', false, 'process-exit'),
  capability('open-url', 1, 'pw-open-url.js', 'Open URL', 'Open an allowed URL in a new browser tab.', 'low', false, 'process-exit'),
] as const;

export const safeActions = new Set([
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

interface CapabilityOptions {
  args?: string[];
  dryRunArgs?: string[];
  card?: boolean;
  picker?: string;
  refreshAfter?: string;
}

function capability(
  id: string,
  version: number,
  script: string,
  label: string,
  description: string,
  risk: Capability['risk'],
  mutatesCourse: boolean,
  verifier: string,
  options: CapabilityOptions = {},
): Capability {
  return { id, version, script, label, description, risk, mutatesCourse, verifier, ...options };
}

export function getCapability(id: string): Capability | null {
  return capabilities.find((item) => item.id === id) ?? null;
}

export function getCapabilityForRun(script: string, args: string[] = []): Capability | null {
  const matches = capabilities.filter((item) => item.script === script);
  return matches.find((item) => (
    item.args?.length === args.length &&
    item.args.every((arg, index) => arg === args[index])
  )) ?? matches.find((item) => !item.args) ?? null;
}

export function isMutatingRun(script: string, args: string[] = []): boolean {
  const capabilityValue = getCapabilityForRun(script, args);
  if (!capabilityValue) return false;
  if (capabilityValue.dryRunArgs?.every((arg) => args.includes(arg))) return false;
  return capabilityValue.mutatesCourse;
}
