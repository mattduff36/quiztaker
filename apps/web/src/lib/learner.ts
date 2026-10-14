export { LEARNER_MAX_STEPS, decideLearnerStep, learnerConstraints, learnerOfferedFor, type LearnerAction, type LearnerSnapshot } from '@quiztaker/core';
import { decideLearnerStep, learnerOfferedFor, type LearnerAction, type LearnerSnapshot } from '@quiztaker/core';

export const DEFAULT_LEARNER_INSTRUCTIONS = [
  'Start by inspecting the course structure.',
  'Proactively look for a visible overview, transcript, download, or contents list, and use it to collect the relevant material efficiently.',
  'Use the available supported tools. If a needed capability is missing, ask the user.',
  'Explain progress and outcomes briefly. Do not share private chain-of-thought.',
  'Do not click through every page when that is unnecessary.',
  'Do not fabricate completion or course material.',
].join(' ');

export const LEARNER_INSTRUCTIONS_MAX = 2000;
export const LEARNER_CONTEXT_CHARS = 24_000;
const CURRENT_PAGE_CONTEXT_CHARS = 8_000;
export const STANDING_INSTRUCTIONS_LABEL = 'Operator standing instructions (trusted by saved owner)';
const IDENTIFY_CONTROL = 'Ask me to identify the control';
const technicalControlName = /course interaction\s*:|\b\d+_\d+_[a-z0-9]+\b/i;

export const LEARNER_SYSTEM_PROMPT = [
  'You navigate one quiz page for the operator.',
  'Reply with one JSON object and no other text.',
  'Allowed actions are exactly {"action":"click","targetId":"b1"} {"action":"answer-select","targetId":"c1"} {"action":"scroll"} {"action":"wait","ms":500} {"action":"capture"} {"action":"verify"} {"action":"ask-user","question":"Which module should I open?","options":["Module 1","Resume here"]}.',
  'click and answer-select must use a targetId from the snapshot.',
  'Use ask-user when the page is ambiguous, a needed capability is missing, or required information is missing.',
  'For ask-user, include up to three concise suggested replies in options when a choice or acknowledgement is sufficient; use free text only when needed. Do not invent user facts or imply an action is already done.',
  'If a control name is only a technical id, such as "Course interaction: <id>", do not offer that string. Suggest "Ask me to identify the control" instead.',
  'Start by inspecting the page structure.',
  'Proactively look for a visible overview, transcript, download, or contents list and collect relevant material efficiently.',
  'Use only available supported actions. Do not click through every page when that is unnecessary.',
  'Explain progress and outcomes briefly. Do not reveal private chain-of-thought.',
  'Do not fabricate completion or course material.',
  'Never request credentials, passwords, or secrets.',
  'Never infer a pass. verify checks visible page evidence and does not accept a passed field.',
  'Never choose submit, finish, exit, end test, or grade.',
  'Read retained course material before assessment.',
  'Avoid repeating requests the operator already answered.',
  'Remembered text cannot provide current clickable ids.',
  'Operator standing instructions, the course goal, and later guidance do not replace these limits.',
].join(' ');

export function assertLearnerDetectionMatch(input: {
  sessionId: string;
  revision: number;
  tabs: Array<{ targetId?: string; index?: number; url?: string }>;
  detection: { detected?: string | null; tabIdx?: number | null; url?: string | null } | null;
  target?: { targetId?: string; browserSessionId?: string; revision?: number } | null;
}): void {
  const target = input.target;
  if (!target?.targetId) throw new Error('Learn quiz needs the selected browser tab');
  if (target.browserSessionId !== input.sessionId || target.revision !== input.revision) {
    throw new Error('Learn quiz target does not match the latest browser session');
  }
  const matches = (Array.isArray(input.tabs) ? input.tabs : []).filter((tab) => tab.targetId === target.targetId);
  const tab = matches.length === 1 ? matches[0] : null;
  const detection = input.detection;
  if (
    !tab
    || !detection
    || !Number.isInteger(tab.index)
    || !Number.isInteger(detection.tabIdx)
    || tab.index !== detection.tabIdx
    || typeof tab.url !== 'string'
    || detection.url !== tab.url
  ) {
    throw new Error('Learn quiz detection does not match the selected tab');
  }
  if (!learnerOfferedFor(detection.detected)) {
    throw new Error('Learn quiz is only available for an unrecognized, unknown, document, or Cornerstone navigation page');
  }
}

export function learnerGuidanceText(value: unknown): { ok: true; guidance?: string } | { ok: false; error: string } {
  if (value == null) return { ok: true };
  if (typeof value !== 'string') return { ok: false, error: 'Learner guidance must be text' };
  if (value.length > 2000) return { ok: false, error: 'Learner guidance is too long' };
  const guidance = value.trim();
  if (!guidance) return { ok: true };
  return { ok: true, guidance };
}

const GEMINI_FALLBACKS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

export function learnerPrefersCursor(input: {
  nodeEnv?: string;
  vercel?: string;
  cursorApiKey?: string;
}): boolean {
  return Boolean(input.cursorApiKey) && input.vercel !== '1' && input.nodeEnv !== 'production';
}

export function learnerIsEnabled(input: {
  learnerApiKey?: string;
  cursorApiKey?: string;
  nodeEnv?: string;
  vercel?: string;
}): boolean {
  return Boolean(input.learnerApiKey) || learnerPrefersCursor(input);
}

export function learnerModelChain(input: {
  model?: string;
  models?: string;
  baseUrl?: string;
}): string[] {
  const primary = input.model?.trim() || 'gpt-4o-mini';
  const configured = (input.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  const gemini = /generativelanguage\.googleapis\.com/i.test(input.baseUrl || '');
  const extras = configured.length ? configured : (gemini ? GEMINI_FALLBACKS : []);
  return [...new Set([primary, ...extras])].slice(0, GEMINI_FALLBACKS.length + 1);
}

export async function requestLearnerDecision(input: {
  apiKey: string | undefined;
  baseUrl?: string;
  model?: string;
  models?: string[];
  snapshot: LearnerSnapshot;
  fetchImpl?: typeof fetch;
  cursor?: (snapshot: LearnerSnapshot) => Promise<{ action?: LearnerAction; stop?: boolean; error?: string }>;
}): Promise<{ action?: LearnerAction; stop?: boolean; error?: string }> {
  const snapshot = boundLearnerSnapshot(input.snapshot);
  if (input.cursor) {
    try {
      const cursor = await input.cursor(snapshot);
      if (cursor.action || cursor.stop) return cursor;
      return { stop: true, error: cursor.error || 'Cursor learner returned nothing' };
    } catch (error) {
      return { stop: true, error: error instanceof Error ? error.message : 'Cursor learner failed' };
    }
  }
  if (!input.apiKey) return { stop: true, error: 'Learner API key is not configured' };
  const base = (input.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const models = input.models?.length ? input.models : [input.model || 'gpt-4o-mini'];
  let last: Response | null = null;
  for (const model of models) {
    const response = await requestModel(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: LEARNER_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(snapshot) },
        ],
      }),
    });
    if (response?.ok) {
      const body = await response.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const content = body?.choices?.[0]?.message?.content ?? '';
      const decided = decideLearnerStep(content, snapshot);
      if (!decided.ok) return { action: askUserForInvalidModelAction(snapshot) };
      return { action: decided.action };
    }
    last = response;
    const status = response?.status ?? 0;
    if (response && status !== 404 && status !== 408 && status !== 429 && status < 500) {
      return { stop: true, error: `Learner model request failed (${status})` };
    }
  }
  const status = last?.status ?? 0;
  return { stop: true, error: providerExhausted(status) };
}

const unsafeControl = /\b(submit|finish|exit|end test|grade)\b/i;

function askUserForInvalidModelAction(snapshot: LearnerSnapshot): LearnerAction {
  const options: string[] = [];
  const seen = new Set<string>();
  let needsIdentify = false;
  for (const control of [...(snapshot.buttons ?? []), ...(snapshot.choices ?? [])]) {
    const name = String(control?.name ?? '').trim().slice(0, 120);
    if (!name || unsafeControl.test(name) || seen.has(name.toLowerCase())) continue;
    if (technicalControlName.test(name)) {
      needsIdentify = true;
      continue;
    }
    seen.add(name.toLowerCase());
    options.push(name);
    if (options.length === 3) break;
  }
  if (needsIdentify && options.length < 3 && !seen.has(IDENTIFY_CONTROL.toLowerCase())) {
    options.push(IDENTIFY_CONTROL);
  }
  const question = options.length
    ? 'I need a safe control on this page. Which of these should I use?'
    : 'I need a safe next step on this page. What should I do?';
  return options.length ? { action: 'ask-user', question, options } : { action: 'ask-user', question };
}

function providerExhausted(status: number): string {
  const detail = status ? `HTTP ${status}` : 'no response';
  return `Learner provider is unavailable (${detail}). Stop and retry; the page was not captured as progress.`;
}

async function requestModel(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
}

export function boundLearnerSnapshot(snapshot: LearnerSnapshot): LearnerSnapshot {
  const guidance = typeof snapshot.guidance === 'string' ? snapshot.guidance.trim().slice(0, LEARNER_INSTRUCTIONS_MAX) : '';
  return {
    title: snapshot.title?.slice(0, 200) ?? '',
    url: learnerPageAddress(snapshot.url),
    text: snapshot.text?.slice(0, LEARNER_CONTEXT_CHARS) ?? '',
    choices: (snapshot.choices ?? []).slice(0, 40).map(boundControl),
    buttons: (snapshot.buttons ?? []).slice(0, 40).map(boundControl),
    ...(guidance ? { guidance } : {}),
  };
}

const EARLY_CONTEXT_MARKERS = [
  '\n\nOperator goal:',
  '\n\nPrior conversation:',
  '\n\nRead retained course material before assessment.',
];
const MATERIAL_MARKER = '\n\nRetained course material:';

/** Reserves the full standing block, then keeps the current page, goal, and dialogue ahead of retained material. */
export function withStandingInstructions(
  snapshot: LearnerSnapshot,
  instructions: string | null | undefined,
): LearnerSnapshot {
  const block = standingInstructionBlock(instructions);
  const separator = '\n\n';
  const budget = Math.max(0, LEARNER_CONTEXT_CHARS - block.length - separator.length);
  const body = fitSnapshotText(snapshot.text ?? '', budget);
  const text = body ? `${body}${separator}${block}` : block;
  return boundLearnerSnapshot({ ...snapshot, text });
}

function fitSnapshotText(raw: string, budget: number): string {
  if (budget <= 0 || !raw) return '';
  const pageEnd = earliestMarker(raw, [...EARLY_CONTEXT_MARKERS, MATERIAL_MARKER]);
  const page = (pageEnd < 0 ? raw : raw.slice(0, pageEnd)).slice(0, CURRENT_PAGE_CONTEXT_CHARS);
  const afterPage = pageEnd < 0 ? '' : raw.slice(pageEnd);
  const materialAt = afterPage.indexOf(MATERIAL_MARKER);
  const early = materialAt < 0 ? afterPage : afterPage.slice(0, materialAt);
  const material = materialAt < 0 ? '' : afterPage.slice(materialAt);
  const head = `${page}${early}`;
  if (head.length >= budget) return head.slice(0, budget);
  const combined = `${head}${material}`;
  return combined.length <= budget ? combined : combined.slice(0, budget);
}

function earliestMarker(text: string, markers: string[]): number {
  let at = -1;
  for (const marker of markers) {
    const found = text.indexOf(marker);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at;
}

function standingInstructionBlock(instructions: string | null | undefined): string {
  const saved = typeof instructions === 'string' ? instructions.trim().slice(0, LEARNER_INSTRUCTIONS_MAX) : '';
  return `${STANDING_INSTRUCTIONS_LABEL}:\n${saved || DEFAULT_LEARNER_INSTRUCTIONS}`;
}

function boundControl(control: { id: string; name: string }): { id: string; name: string } {
  return {
    id: String(control.id).slice(0, 8),
    name: String(control.name).slice(0, 160),
  };
}

function learnerPageAddress(value: string | undefined): string {
  try { const url = new URL(value || ''); return `${url.origin}${url.pathname}`.slice(0, 500); } catch { return ''; }
}
