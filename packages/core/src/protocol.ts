import { createHash } from 'node:crypto';
import { getCapability } from './capabilities.js';

export const PROTOCOL_VERSION = 2;
export const RESULT_SCHEMA_VERSION = 1;

const QUIZ_EXECUTOR = /^pw-quiz-/;

export interface TargetRef {
  browserSessionId: string;
  revision: number;
  targetId: string;
  fingerprint: string;
}

export interface BrowserTabSnapshot {
  targetId: string;
  index: number;
  title: string;
  url: string;
  fingerprint: string;
  hasFocus?: boolean;
}

export interface BrowserSessionSnapshot {
  id: string;
  revision: number;
  tabs: BrowserTabSnapshot[];
}

export interface ResultEnvelope<T = unknown> {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  capabilityId: string;
  ok: boolean;
  result: T;
}

export interface ValidationSuccess {
  ok: true;
  args: string[];
}

export interface ValidationFailure {
  ok: false;
  error: string;
}

export function sanitizeRecentUrl(value: string): string | null {
  return canonicalHttpUrl(value, { allowHash: false });
}

export function validateOpenUrl(value: string): string | null {
  return canonicalHttpUrl(value, { allowHash: true });
}

export function validateCapabilityInput(
  capabilityId: string,
  input: Record<string, unknown>,
): ValidationSuccess | ValidationFailure {
  const capability = getCapability(capabilityId);
  if (!capability || QUIZ_EXECUTOR.test(capability.script)) {
    return { ok: false, error: 'Unknown capability' };
  }
  if (input.capabilityId !== capabilityId) return { ok: false, error: 'Capability input does not match' };

  try {
  switch (capabilityId) {
    case 'start-browser':
    case 'list-tabs':
    case 'cdp-check':
    case 'close-browser':
      return { ok: true, args: [] };
    case 'cert-dry-run':
      return { ok: true, args: ['--dry'] };
    case 'open-url': {
      const url = typeof input.url === 'string' ? validateOpenUrl(input.url) : null;
      if (!url) return { ok: false, error: 'Open URL must be an HTTP or HTTPS address' };
      return { ok: true, args: [url] };
    }
    case 'fit-tab':
    case 'tab-inspect':
    case 'slickquiz-solve':
      return argsForTarget(input.target);
    case 'detect':
    case 'cert-status':
    case 'learn-capture':
      return input.target == null
        ? { ok: true, args: [] }
        : argsForTarget(input.target);
    case 'scorm-complete':
    case 'container-batch':
      return withDryRun(argsForTarget(input.target), input.dryRun === true);
    case 'cert-batch':
      return withDryRun({ ok: true, args: onlyArgs(input.titles) }, input.dryRun === true);
    case 'class-batch': {
      const targeted = argsForTarget(input.target);
      if (!targeted.ok) return targeted;
      return withDryRun({ ok: true, args: [...targeted.args, ...onlyArgs(input.titles)] }, input.dryRun === true);
    }
    default:
      return { ok: false, error: 'Capability input is not supported' };
  }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Capability input is invalid' };
  }
}

export function resolveScriptArgs(
  capabilityId: string,
  args: string[],
  session: BrowserSessionSnapshot | null,
): string[] {
  const targetId = flagValue(args, '--target');
  const consumed = new Set<number>();
  if (targetId) {
    if (!session) throw new Error('Browser session is stale');
    const sessionId = flagValue(args, '--session');
    const revision = Number(flagValue(args, '--revision'));
    const fingerprint = flagValue(args, '--fingerprint');
    if (session.id !== sessionId || session.revision !== revision) throw new Error('Browser session is stale');
    const matches = session.tabs.filter((item) => item.targetId === targetId);
    const tab = matches.length === 1 ? matches[0] : null;
    if (!tab || tab.fingerprint !== fingerprint) throw new Error('Browser target is stale');
    markFlag(args, '--target', consumed);
    markFlag(args, '--session', consumed);
    markFlag(args, '--revision', consumed);
    markFlag(args, '--fingerprint', consumed);
    const rest = args.filter((_, index) => !consumed.has(index));
    if (capabilityId === 'slickquiz-solve') return ['--tab', String(tab.index), ...rest];
    return [String(tab.index), ...rest];
  }
  return args;
}

export function assertFreshTarget(
  input: Record<string, unknown>,
  session: BrowserSessionSnapshot,
): void {
  if (!input.target || typeof input.target !== 'object') return;
  const target = input.target as Partial<TargetRef>;
  const matches = session.tabs.filter((item) => item.targetId === target.targetId);
  const tab = matches.length === 1 ? matches[0] : null;
  if (
    target.browserSessionId !== session.id ||
    target.revision !== session.revision ||
    !tab ||
    tab.fingerprint !== target.fingerprint
  ) throw new Error('Browser target is stale');
}

export function fingerprintForUrl(value: string): string {
  return createHash('sha256').update(sanitizeRecentUrl(value) || value).digest('hex').slice(0, 24);
}

export function resultEnvelope<T>(capabilityId: string, ok: boolean, result: T): ResultEnvelope<T> {
  return { schemaVersion: RESULT_SCHEMA_VERSION, capabilityId, ok, result };
}

function argsForTarget(value: unknown): ValidationSuccess | ValidationFailure {
  const target = readTarget(value);
  if (!target) return { ok: false, error: 'A current browser target is required' };
  const args = [
    '--target', target.targetId,
    '--session', target.browserSessionId,
    '--revision', String(target.revision),
    '--fingerprint', target.fingerprint,
  ];
  return { ok: true, args };
}

function readTarget(value: unknown): TargetRef | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<TargetRef>;
  if (
    typeof target.browserSessionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(target.browserSessionId) ||
    typeof target.targetId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(target.targetId) ||
    typeof target.fingerprint !== 'string' ||
    !/^[0-9a-f]{24}$/i.test(target.fingerprint) ||
    !Number.isInteger(target.revision) ||
    Number(target.revision) < 1
  ) return null;
  return target as TargetRef;
}

function onlyArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('Select at least one item');
  }
  return value.map((title) => {
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 500 || title.includes('\n')) {
      throw new Error('Selected item title is invalid');
    }
    return `--only=${title.trim()}`;
  });
}

function withDryRun(
  value: ValidationSuccess | ValidationFailure,
  dryRun: boolean,
): ValidationSuccess | ValidationFailure {
  if (!value.ok || !dryRun) return value;
  return { ok: true, args: [...value.args, '--dry'] };
}

function markFlag(args: string[], flag: string, consumed: Set<number>): void {
  const index = args.indexOf(flag);
  if (index >= 0) {
    consumed.add(index);
    consumed.add(index + 1);
  }
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function canonicalHttpUrl(value: string, options: { allowHash: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.href.length > 2000) return null;
  url.username = '';
  url.password = '';
  if (!options.allowHash) url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|password|passwd|code|session|auth|credential/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}
