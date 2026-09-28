import { resultEnvelope } from '@quiztaker/core';
import { readBrowserSession, replaceBrowserSession } from './browser-session.js';

export function structuredResult(
  capabilityId: string,
  output: string,
  code: number | null,
): Record<string, unknown> {
  const parsed = parseJson(output);
  if (capabilityId === 'list-tabs' && Array.isArray(parsed)) {
    const browserSession = replaceBrowserSession(parsed as Array<{ idx?: number; title?: string; url?: string; hasFocus?: boolean }>);
    return { ...resultEnvelope(capabilityId, code === 0, { browserSession }) };
  }
  if (capabilityId === 'cdp-check') {
    const connected = Boolean((parsed as { ok?: boolean } | null)?.ok);
    const session = readBrowserSession();
    return { ...resultEnvelope(capabilityId, connected, {
      connected,
      ...(session ? { browserSession: { ...session, cdpConnected: connected } } : {}),
    }) };
  }
  if (capabilityId === 'cert-status' && parsed && typeof parsed === 'object') {
    return { ...resultEnvelope(capabilityId, code === 0, {
      browserSession: readBrowserSession() ?? replaceBrowserSession([]),
      roster: parsed,
    }) };
  }
  if (capabilityId === 'detect' && parsed && typeof parsed === 'object') {
    return { ...resultEnvelope(capabilityId, code === 0, {
      browserSession: readBrowserSession() ?? replaceBrowserSession([]),
      detection: parsed,
    }) };
  }
  if (capabilityId === 'open-url') {
    return { ...resultEnvelope(capabilityId, code === 0, parsed ?? { ok: code === 0 }) };
  }
  if (capabilityId === 'learn-capture' && parsed && typeof parsed === 'object') {
    const capture = parsed as { fingerprint?: string; title?: string; url?: string; detected?: string; dir?: string };
    return { ...resultEnvelope(capabilityId, code === 0, {
      fingerprint: capture.fingerprint,
      title: capture.title || 'Learning capture',
      detail: capture.detected || '',
      url: capture.url,
      browserSession: readBrowserSession(),
    }) };
  }
  if (capabilityId === 'close-browser') {
    return { ...resultEnvelope(capabilityId, code === 0, { closed: code === 0 }) };
  }
  return { ...resultEnvelope(capabilityId, code === 0, { exitCode: code }) };
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.max(trimmed.lastIndexOf('\n{'), trimmed.lastIndexOf('\n['));
    if (start === -1) return null;
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      return null;
    }
  }
}
