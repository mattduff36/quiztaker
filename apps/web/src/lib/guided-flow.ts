import type { LearnerIntent, LearnerMode } from '@quiztaker/core';

export type GuidedLearningMode = LearnerMode | LearnerIntent;

export type GuidedDetection = {
  detected?: string;
  tabIdx?: number;
  url?: string;
  fingerprint?: string;
  detail?: string;
  action?: { capabilityId?: string; label?: string } | null;
};

export type GuidedDecision =
  | { kind: 'run'; capability: string; message: string }
  | { kind: 'learn'; message: string }
  | { kind: 'question'; question: string; next: string };

const known = new Set(['scorm-complete', 'container-batch', 'slickquiz-solve']);
const learnable = new Set(['unknown', 'none', 'document-wbt', 'csod-curriculum', 'csod-learning']);

export function decideGuidedFlow(detection: GuidedDetection, mode: GuidedLearningMode = 'read'): GuidedDecision {
  if (detection.detected === 'session-dead') return {
    kind: 'question', question: 'Can you sign in to the course website in the helper browser?', next: 'I have signed in — inspect again',
  };
  if (detection.detected === 'server-assessment' && mode === 'read') return {
    kind: 'question', question: 'This page is a quiz. Choose an assessment option to answer and submit it, or choose a course-material page to read.', next: 'Inspect the current page again',
  };
  if (known.has(detection.action?.capabilityId || '') || learnable.has(detection.detected || '') || detection.detected === 'server-assessment') return {
    kind: 'learn', message: {
      read: 'Reading the course pages and collecting material for later questions.',
      quiz: 'Using retained course material to work through the quiz and inspect its result.',
      'read-and-assess': 'Reading the course material and using it to answer assessment questions.',
      coordinate: 'Reading and working through the assessment, with Codex available to help when Vitriol gets stuck.',
    }[mode],
  };
  return {
    kind: 'question', question: 'Which course or module do you want to work on? Open it in the helper browser, then continue here.', next: 'I have opened it — inspect again',
  };
}

export function learnerQuestion(output: string): { question: string; options: string[]; url?: string } | null {
  const lines = output.split('\n').filter((line) => line.startsWith('LEARNER_QUESTION '));
  try {
    const value = JSON.parse(lines.at(-1)?.slice('LEARNER_QUESTION '.length) || 'null');
    if (!value || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 500) return null;
    const options = Array.isArray(value.options) ? value.options.filter((option: unknown) => typeof option === 'string' && option.length <= 120).slice(0, 3) : [];
    if (value.url != null && (typeof value.url !== 'string' || !value.url || value.url.length > 500 || !/^https?:\/\//i.test(value.url))) return null;
    return { question: value.question, options, ...(value.url ? { url: value.url } : {}) };
  } catch { return null; }
}

export function learnerStopMessage(output: string): string | null {
  const line = output.split('\n').findLast(entry => entry.startsWith('AUTOMATION_RESULT '));
  let reason: unknown;
  try { reason = JSON.parse(line?.slice('AUTOMATION_RESULT '.length) || 'null')?.failures?.[0]?.reason; } catch { /* Legacy runs may only have a browser error. */ }
  if (reason === 'blocked-control' || /locator\.click: Timeout|intercepts pointer events/i.test(output)) {
    return 'Vitriol could not click the course control. The page was left open. Try opening the next page manually or use Co-ordinate with ChatGPT.';
  }
  if (reason === 'quiz-failed') return 'The assessment showed a failed result. Review the feedback in the course browser.';
  if (reason === 'step-cap') return 'Vitriol reached the step limit for this run. Continue from the current page in the course browser.';
  if (reason === 'rejected-action') return 'The suggested action did not match an available course control. Inspect the current page again.';
  if (/Learner input timed out/i.test(output)) return 'Vitriol timed out waiting for a next-step decision. The course page was left open.';
  return null;
}

export function uniqueQuestionTab<T extends { targetId: string; url: string }>(url: string | undefined, tabs: T[]): T | null {
  if (!url) return null;
  const matches = tabs.filter((tab) => tab.url === url);
  return matches.length === 1 ? matches[0] : null;
}

export function sameDetectedTarget(detection: GuidedDetection, tab: { index: number; url: string }): boolean {
  return detection.tabIdx === tab.index && detection.url === tab.url;
}

export function supportsGuidedLearning(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 0 || (minor === 0 && patch >= 15)));
}
