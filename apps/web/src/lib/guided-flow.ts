import type { LearnerIntent, LearnerMode } from '@quiztaker/core';

export type GuidedLearningMode = LearnerMode | LearnerIntent;
export type IndependentIntent = Exclude<GuidedLearningMode, 'coordinate'>;

export const independentPlans: Record<IndependentIntent, string> = {
  read: 'I’ll read and retain the course material.',
  quiz: 'I’ll answer and submit the quiz, then check the result.',
  'read-and-assess': 'I’ll work through the lessons, then take the assessment.',
};

export function independentIntent(goal: string): IndependentIntent | null {
  const text = goal.toLowerCase().replace(/[’‘]/g, "'");
  const reading = /\b(?:read|review|study|learn|collect|retain|summari[sz]e|cover)\b/.test(text)
    || /\b(?:complete|finish|work through)\s+(?:(?:the|all|required|unfinished)\s+)*(?:lessons?|modules?)\b/.test(text);
  const material = /\b(?:material|lessons?|modules?|content|slides?|course|transcript|notes)\b/.test(text);
  const assessment = /\b(?:quiz|quizzes|assessments?|exams?|tests?|knowledge checks?)\b/.test(text);
  if (!assessment) return reading ? 'read' : null;
  // Submission prohibitions are global; exclusions of a named completed course
  // and optional review wording apply only to their own clause.
  if (/\b(?:read[- ]only|only read|(?:do not|don't|never|without)\s+submit(?:ting)?|no submissions?)\b/.test(text)) return reading ? 'read' : null;
  const clauses = text.split(/[.;\n]|\b(?:and then|then|but|also|and)\b/);
  let action = false, denied = false;
  for (const clause of clauses) {
    if (/\b(?:without|skip|do not|don't|never|avoid|no)\b/.test(clause)) { denied = true; continue; }
    if (/\b(?:how to|whether|if|later|help me|explain|prepare)\b/.test(clause)) continue;
    if (/\b(?:take|pass|submit|answer|complete|attempt|do|finish|work through)\s+[^.;\n]{0,100}\b(?:quiz|quizzes|assessments?|exams?|tests?|knowledge checks?)\b/.test(clause)) action = true;
  }
  return action ? (reading && material ? 'read-and-assess' : 'quiz') : denied && reading ? 'read' : null;
}

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
const learnable = new Set(['unknown', 'none', 'document-wbt', 'csod-curriculum', 'csod-learning', 'class-detail', 'cert-landing']);

export function decideGuidedFlow(detection: GuidedDetection, mode: GuidedLearningMode = 'read'): GuidedDecision {
  if (detection.detected === 'session-dead') return {
    kind: 'question', question: 'Can you sign in to the course website in the helper browser?', next: 'I have signed in — inspect again',
  };
  if (detection.detected === 'server-assessment' && mode === 'read') return {
    kind: 'question', question: 'This page is a quiz. To answer and submit it, update your goal. To keep reading, open a lesson in the course browser.', next: 'Inspect the current page again',
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

export function learnerQuestion(output: string): { question: string; options: string[]; url?: string; cdpTargetId?: string } | null {
  if (/Learner input (?:timed out|closed)|(?:decision|coordination).{0,30}timed out/i.test(output)) return null;
  const terminal = output.split('\n').findLast(line => line.startsWith('AUTOMATION_RESULT '));
  if (terminal) {
    try {
      const result = JSON.parse(terminal.slice('AUTOMATION_RESULT '.length));
      if (result.ok === true || result.failures?.some((failure: {reason?:string}) => failure.reason && failure.reason !== 'needs-user-input')) return null;
    } catch { return null; }
  }
  const lines = output.split('\n').filter((line) => line.startsWith('LEARNER_QUESTION '));
  try {
    const value = JSON.parse(lines.at(-1)?.slice('LEARNER_QUESTION '.length) || 'null');
    if (!value || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 500) return null;
    const options = Array.isArray(value.options) ? value.options.filter((option: unknown) => typeof option === 'string' && option.length <= 120).slice(0, 3) : [];
    if (value.url != null && (typeof value.url !== 'string' || !value.url || value.url.length > 2000 || !/^https?:\/\//i.test(value.url))) return null;
    if (value.cdpTargetId != null && (typeof value.cdpTargetId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.cdpTargetId))) return null;
    return { question: value.question, options, ...(value.url ? { url: value.url } : {}), ...(value.cdpTargetId ? {cdpTargetId:value.cdpTargetId} : {}) };
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
  if (reason === 'learner-interrupted' || /Learner input (?:timed out|closed)/i.test(output)) return 'The run was interrupted while waiting for a next-step decision. The course page was left open. Resume from the current page; do not restart the assessment.';
  return null;
}

export function observedQuizResult(result: unknown): { heading: string; detail: string } | null {
  const value = (result as { result?: { quizResult?: { status?: unknown; scorePercent?: unknown; passingScorePercent?: unknown } } } | null)?.result?.quizResult;
  if (value?.status !== 'passed' && value?.status !== 'failed') return null;
  const percent = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 100 ? `${number}%` : null;
  const score = percent(value.scorePercent);
  const threshold = percent(value.passingScorePercent);
  return {
    heading: `Quiz ${value.status}${score ? ` · ${score}` : ''}`,
    detail: [threshold ? `Pass mark ${threshold}.` : '', value.status === 'passed'
      ? 'Check the course progress in the learning portal and finish any remaining lessons.'
      : 'Review the feedback in the course browser.'].filter(Boolean).join(' '),
  };
}

export function uniqueQuestionTab<T extends { targetId: string; url: string }>(url: string | undefined, tabs: T[]): T | null {
  if (!url) return null;
  const matches = tabs.filter((tab) => tab.url === url);
  return matches.length === 1 ? matches[0] : null;
}

export function questionTargetTab<T extends {targetId:string;cdpTargetId?:string;url:string}>(
  question: {url?:string;targetId?:string;cdpTargetId?:string} | null | undefined, tabs: T[], fallbackTargetId?: string,
): T | null {
  if (!question?.url) return null;
  const targetId=question.targetId || fallbackTargetId;
  if (!question.cdpTargetId && !targetId) return null;
  const matches=tabs.filter(tab=>tab.url===question.url && (question.cdpTargetId ? tab.cdpTargetId===question.cdpTargetId : tab.targetId===targetId));
  return matches.length===1 ? matches[0] : null;
}

export function sameDetectedTarget(detection: GuidedDetection, tab: { index: number; url: string }): boolean {
  return detection.tabIdx === tab.index && detection.url === tab.url;
}

export function supportsGuidedLearning(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 0 || (minor === 0 && patch >= 15)));
}
