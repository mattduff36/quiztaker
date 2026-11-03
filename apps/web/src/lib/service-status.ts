/** Public service evidence only; configuration is never a live provider health check. */
export interface ServiceStatusSnapshot {
  checkedAt: string;
  helper: { online: boolean; lastSeenAt: string | null } | null;
  browser: { connected: boolean; checkedAt: string | null } | null;
  assistant: { ready: boolean; source: string; provider: string | null };
  activity?: { session: boolean; task: boolean };
}

/** Browser details belong to course work, rather than general site browsing. */
export function browserStatusRelevant(snapshot: ServiceStatusSnapshot | null, pathname: string): boolean {
  return snapshot?.activity?.task === true || (pathname === '/' && snapshot?.activity?.session === true);
}

export type ServiceTone = 'good' | 'warning' | 'bad' | 'unknown';
export interface ServiceIndicator {
  id: string;
  label: string;
  state: string;
  detail: string;
  tone: ServiceTone;
  href: string;
}

export const SERVICE_POLL_MS = 20_000;
export const SERVICE_HIDDEN_POLL_MS = 60_000;
export const SERVICE_STALE_MS = 45_000;

function recent(value: string | null, now: number, maxAge: number): boolean {
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && now - date >= -5_000 && now - date <= maxAge;
}

export function serviceIndicators(input: {
  snapshot: ServiceStatusSnapshot | null;
  now: number;
  failed?: boolean;
  offline?: boolean;
}): ServiceIndicator[] {
  const { snapshot, now, failed, offline } = input;
  const base = [
    { id: 'website', label: 'Website', href: '/', detail: 'Vitriol website and status service.' },
    { id: 'helper', label: 'Helper', href: '/helper', detail: 'The Windows helper on your PC.' },
    { id: 'browser', label: 'Browser', href: '/', detail: 'The browser connection last checked by the helper.' },
    { id: 'assistant', label: 'Assistant', href: '/settings', detail: 'Assistant configuration; provider availability is checked when a task runs.' },
  ];
  if (offline || failed || !snapshot || !recent(snapshot.checkedAt, now, SERVICE_STALE_MS)) {
    const state = offline ? 'Offline' : failed ? 'Unavailable' : snapshot ? 'Check overdue' : 'Checking';
    return base.map(item => ({ ...item, state: item.id === 'website' ? state : offline || failed ? 'Unknown' : state,
      tone: (offline || failed) && item.id === 'website' ? 'bad' : 'unknown',
      detail: offline ? 'This page is offline. Service states cannot be checked.' : failed ? 'The status check failed. Retrying automatically; previous connection states are not current.' : item.detail }));
  }
  const helperOnline = snapshot.helper?.online && recent(snapshot.helper.lastSeenAt, now, 45_000);
  const browserFresh = snapshot.browser && recent(snapshot.browser.checkedAt, now, 90_000);
  return [
    { ...base[0], state: 'Online', tone: 'good' },
    { ...base[1], state: !snapshot.helper ? 'Not paired' : helperOnline ? 'Connected' : 'Offline', tone: helperOnline ? 'good' : 'warning' },
    { ...base[2], state: !helperOnline ? 'Unknown' : !snapshot.browser ? 'Not checked' : !browserFresh ? 'Check overdue' : snapshot.browser.connected ? 'Connected' : 'Disconnected', tone: helperOnline && browserFresh ? snapshot.browser!.connected ? 'good' : 'warning' : 'unknown' },
    { ...base[3], state: snapshot.assistant.ready ? 'Configured' : snapshot.assistant.source === 'disabled' ? 'Disabled' : 'Set up', tone: snapshot.assistant.ready ? 'good' : 'warning' },
  ];
}

export function servicePollDelay(visible: boolean, failures: number): number {
  return visible ? Math.min(SERVICE_POLL_MS * 2 ** Math.min(failures, 2), SERVICE_HIDDEN_POLL_MS) : SERVICE_HIDDEN_POLL_MS;
}
