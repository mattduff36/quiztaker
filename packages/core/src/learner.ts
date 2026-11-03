import { getCapability } from './capabilities.js';

export const LEARNER_MAX_STEPS = 80;
export type LearnerMode = 'read' | 'quiz';
export interface LearnerPolicy { mode: LearnerMode }

export const learnerActions = new Set([
  'click',
  'answer-select',
  'scroll',
  'wait',
  'capture',
  'verify',
  'ask-user',
  'select-tab',
]);

const deniedLearnerActions = new Set(['exit', 'submit', 'launch', 'scorm-complete']);
const submitLabel = /\b(submit|finish|end test|end quiz|grade)\b/i;
const navigationLabel = /^(next(?: page| slide)?[ »›→]*|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch|resume|menu|home|contents)$/i;
const assessmentStartLabel = /\b(?:(?:start|begin|launch|take)(?:\s+the)?\s+(?:test|quiz|assessment)|retake|retry)\b/i;
const openTopicLabel = /^Open topic: .{1,140}$/;
const courseInteractionLabel = /^Course interaction: \d+_\d+_click_?\d+$/;

export interface LearnerControl {
  id: string;
  name: string;
  kind?: 'content' | 'navigation' | 'quiz-navigation' | 'submission';
}

export interface LearnerSnapshot {
  title?: string;
  url?: string;
  text?: string;
  choices?: LearnerControl[];
  buttons?: LearnerControl[];
  tabs?: Array<{id: string; name: string; url: string}>;
  /** Operator resume note. At most 2000 characters. */
  guidance?: string;
}

export type LearnerAction =
  | { action: 'click'; targetId: string }
  | { action: 'answer-select'; targetId: string }
  | { action: 'select-tab'; targetId: string }
  | { action: 'scroll' }
  | { action: 'wait'; ms: number }
  | { action: 'capture' }
  | { action: 'verify' }
  | { action: 'ask-user'; question: string; options?: string[] };

export function parseLearnerMode(value: unknown): LearnerMode {
  if (value == null) return 'read';
  if (value !== 'read' && value !== 'quiz') throw new Error('Learner mode is invalid');
  return value;
}
export function learnerConstraints(mode: LearnerMode = 'read') {
  return { mode, maxSteps: LEARNER_MAX_STEPS, submissionAuthorized: mode === 'quiz', allowedActions: [...learnerActions] };
}
/** Trust only stored plan input and server-derived constraints, never page fields. */
export function storedLearnerPolicy(input: { mode?: unknown } | null, constraints: { mode?: unknown; submissionAuthorized?: unknown } | null): LearnerPolicy {
  const mode = parseLearnerMode(input?.mode);
  if (mode === 'quiz' && (constraints?.mode !== 'quiz' || constraints.submissionAuthorized !== true)) throw new Error('Quiz submission is not authorized by this plan');
  if (mode === 'read' && constraints?.submissionAuthorized === true) throw new Error('Learner plan mode does not match');
  return { mode };
}
const unsafeLabel = /\b(log\s*out|sign\s*out|sign\s*in|log\s*in|password|account|payment|purchase|buy|delete|remove|unsubscribe|exit|close browser)\b/i;
export function learnerControlAllowed(target: LearnerControl, policy: LearnerPolicy = { mode: 'read' }): boolean {
  const label = target.name.trim();
  if (!label || unsafeLabel.test(label)) return false;
  if (assessmentStartLabel.test(label)) return policy.mode === 'quiz';
  if (target.kind === 'submission' || submitLabel.test(label)) return policy.mode === 'quiz';
  if (target.kind === 'quiz-navigation') return policy.mode === 'quiz';
  return target.kind === 'content' || target.kind === 'navigation' || navigationLabel.test(label) || openTopicLabel.test(label) || courseInteractionLabel.test(label);
}

export function confirmShortcutAllowed(capabilityId: string): boolean {
  const capability = getCapability(capabilityId);
  return Boolean(capability && !capability.mutatesCourse);
}

export function learnerOfferedFor(detected: string | null | undefined, mode: LearnerMode = 'read'): boolean {
  return ['unknown', 'document-wbt', 'none', 'csod-curriculum', 'csod-learning', 'scorm-player', 'container', 'slickquiz-exam'].includes(detected ?? '') || (mode === 'quiz' && detected === 'server-assessment');
}

export function parseLearnerAction(
  value: unknown,
  snapshot: LearnerSnapshot,
  policy: LearnerPolicy = { mode: 'read' },
): { ok: true; action: LearnerAction } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Learner action is missing' };
  const record = normalizeLearnerActionRecord(value as Record<string, unknown>);
  const name = typeof record.action === 'string' ? record.action : '';
  if (deniedLearnerActions.has(name) || !learnerActions.has(name)) {
    return { ok: false, error: 'Learner action is not allowed' };
  }
  if (name === 'select-tab') {
    const targetId = typeof record.targetId === 'string' ? record.targetId : '';
    const tab = snapshot.tabs?.find(item => item.id === targetId);
    if (!/^t\d{1,3}$/.test(targetId) || !tab || unsafeLabel.test(tab.name)) return {ok:false,error:'Learner tab is not on the page'};
    try {
      const current = new URL(snapshot.url || '');
      const target = new URL(tab.url);
      if (!/^https?:$/.test(current.protocol) || current.origin !== target.origin) throw new Error();
    } catch { return {ok:false,error:'Learner tab must belong to the same course website'}; }
    return {ok:true,action:{action:'select-tab',targetId}};
  }
  if (name === 'click' || name === 'answer-select') {
    const targetId = typeof record.targetId === 'string' ? record.targetId : '';
    if (!/^[a-z]\d{1,3}$/.test(targetId)) return { ok: false, error: 'Learner target is invalid' };
    const pool = name === 'click' ? snapshot.buttons : snapshot.choices;
    const target = (pool ?? []).find((item) => item.id === targetId);
    if (!target) return { ok: false, error: 'Learner target is not on the page' };
    if (name === 'click' && !learnerControlAllowed(target, policy)) return { ok: false, error: 'Learner cannot submit the quiz or use this control in the selected mode' };
    return { ok: true, action: { action: name, targetId } };
  }
  if (name === 'ask-user') return parseAskUser(record);
  if (name === 'wait') {
    const requested = typeof record.ms === 'number' && Number.isFinite(record.ms) ? record.ms : 500;
    return { ok: true, action: { action: 'wait', ms: Math.max(0, Math.min(1000, Math.floor(requested))) } };
  }
  if (name === 'verify') return { ok: true, action: { action: 'verify' } };
  if (name === 'scroll' || name === 'capture') return { ok: true, action: { action: name } };
  return { ok: false, error: 'Learner action is not allowed' };
}

export function decideLearnerStep(
  modelText: string,
  snapshot: LearnerSnapshot,
  policy: LearnerPolicy = { mode: 'read' },
): { ok: true; action: LearnerAction } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(modelText));
  } catch {
    return { ok: false, error: 'Learner response was not JSON' };
  }
  return parseLearnerAction(parsed, snapshot, policy);
}

function normalizeLearnerActionRecord(record: Record<string, unknown>): Record<string, unknown> {
  const wrapped = record.action;
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return record;
  const inner = wrapped as Record<string, unknown>;
  if (typeof inner.action !== 'string') return record;
  const siblings = { ...record };
  delete siblings.action;
  return { ...siblings, ...inner };
}

function parseAskUser(
  record: Record<string, unknown>,
): { ok: true; action: LearnerAction } | { ok: false; error: string } {
  const question = typeof record.question === 'string' ? record.question.trim() : '';
  if (!question || question.length > 500) return { ok: false, error: 'Learner question is invalid' };
  const action: Extract<LearnerAction, { action: 'ask-user' }> = { action: 'ask-user', question };
  if (record.options == null) return { ok: true, action };
  if (!Array.isArray(record.options) || record.options.length > 3) {
    return { ok: false, error: 'Learner question options are invalid' };
  }
  const options: string[] = [];
  for (const option of record.options) {
    if (typeof option !== 'string') return { ok: false, error: 'Learner question options are invalid' };
    const text = option.trim();
    if (!text || text.length > 120) return { ok: false, error: 'Learner question options are invalid' };
    options.push(text);
  }
  if (options.length) action.options = options;
  return { ok: true, action };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Learner response was not JSON');
  return trimmed.slice(start, end + 1);
}
