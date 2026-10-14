export const LEARNER_ACTIVITY_LIMIT = 8;
const PROGRESS_CHARS = 240;

const STEP_STATUS: Record<string, string> = {
  click: 'Selecting a control',
  'answer-select': 'Choosing an answer',
  scroll: 'Moving through the page',
  wait: 'Waiting for the page',
  capture: 'Reading the page',
  verify: 'Checking the page',
  'ask-user': 'Waiting for your reply',
  'page does not show a pass': 'The page does not show completion yet',
  'page changed while deciding; inspecting again': 'The page changed and is being inspected again',
};

/** Latest concise statuses from helper output. Malformed progress lines are skipped. */
export function learnerActivityUpdates(output: string, limit = LEARNER_ACTIVITY_LIMIT): string[] {
  const updates: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const marked = line.match(/^LEARNER_PROGRESS\s+(\{.*\})\s*$/);
    if (marked) {
      const message = progressMessage(marked[1] ?? '');
      if (message) updates.push(message);
      continue;
    }
    const step = line.match(/^Learner step (\d+):\s*(.*)$/);
    if (!step) continue;
    const status = neutralStepStatus(step[1] ?? '', step[2] ?? '');
    if (status) updates.push(status);
  }
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : LEARNER_ACTIVITY_LIMIT;
  return cap ? updates.slice(-cap) : [];
}

function progressMessage(payload: string): string | null {
  try {
    const value = JSON.parse(payload) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = (value as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const text = message.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!text || Array.from(text).length > PROGRESS_CHARS) return null;
    if (/^[{\[]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function neutralStepStatus(step: string, action: string): string | null {
  const detail = action.trim().replace(/\s+/g, ' ');
  if (!detail || detail.length > 160 || /[{}[\]"]/.test(detail)) return null;
  return `Step ${step}: ${STEP_STATUS[detail] ?? 'In progress'}`;
}
