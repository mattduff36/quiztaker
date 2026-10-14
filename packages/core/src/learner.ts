import { getCapability } from './capabilities.js';

export const LEARNER_MAX_STEPS = 80;

export const learnerActions = new Set([
  'click',
  'answer-select',
  'scroll',
  'wait',
  'capture',
  'verify',
  'ask-user',
]);

const deniedLearnerActions = new Set(['exit', 'submit', 'launch', 'scorm-complete']);
const submitLabel = /\b(submit|finish|exit|end test|grade)\b/i;
const navigationLabel = /^(next(?: page| slide)?|continue|back|previous(?: page| slide)?|ok|close|start(?: course| module)?|begin|launch|resume|menu|home|contents)$/i;
const openTopicLabel = /^Open topic: .{1,140}$/;
const courseInteractionLabel = /^Course interaction: \d+_\d+_click\d+$/;

export interface LearnerControl {
  id: string;
  name: string;
}

export interface LearnerSnapshot {
  title?: string;
  url?: string;
  text?: string;
  choices?: LearnerControl[];
  buttons?: LearnerControl[];
  /** Operator resume note. At most 2000 characters. */
  guidance?: string;
}

export type LearnerAction =
  | { action: 'click'; targetId: string }
  | { action: 'answer-select'; targetId: string }
  | { action: 'scroll' }
  | { action: 'wait'; ms: number }
  | { action: 'capture' }
  | { action: 'verify' }
  | { action: 'ask-user'; question: string; options?: string[] };

export function learnerConstraints(): {
  maxSteps: number;
  submissionAuthorized: false;
  allowedActions: string[];
} {
  return {
    maxSteps: LEARNER_MAX_STEPS,
    submissionAuthorized: false,
    allowedActions: [...learnerActions],
  };
}

export function confirmShortcutAllowed(capabilityId: string): boolean {
  const capability = getCapability(capabilityId);
  return Boolean(capability && !capability.mutatesCourse);
}

export function learnerOfferedFor(detected: string | null | undefined): boolean {
  return detected === 'unknown'
    || detected === 'document-wbt'
    || detected === 'none'
    || detected === 'csod-curriculum'
    || detected === 'csod-learning';
}

export function parseLearnerAction(
  value: unknown,
  snapshot: LearnerSnapshot,
): { ok: true; action: LearnerAction } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Learner action is missing' };
  const record = value as Record<string, unknown>;
  const name = typeof record.action === 'string' ? record.action : '';
  if (deniedLearnerActions.has(name) || !learnerActions.has(name)) {
    return { ok: false, error: 'Learner action is not allowed' };
  }
  if (name === 'click' || name === 'answer-select') {
    const targetId = typeof record.targetId === 'string' ? record.targetId : '';
    if (!/^[a-z]\d{1,3}$/.test(targetId)) return { ok: false, error: 'Learner target is invalid' };
    const pool = name === 'click' ? snapshot.buttons : snapshot.choices;
    const target = (pool ?? []).find((item) => item.id === targetId);
    if (!target) return { ok: false, error: 'Learner target is not on the page' };
    if (submitLabel.test(target.name)) return { ok: false, error: 'Learner cannot submit the quiz' };
    if (name === 'click') {
      const label = target.name.trim();
      if (!navigationLabel.test(label) && !openTopicLabel.test(label) && !courseInteractionLabel.test(label)) {
        return { ok: false, error: 'Learner click is limited to navigation controls' };
      }
    }
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
): { ok: true; action: LearnerAction } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(modelText));
  } catch {
    return { ok: false, error: 'Learner response was not JSON' };
  }
  return parseLearnerAction(parsed, snapshot);
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
