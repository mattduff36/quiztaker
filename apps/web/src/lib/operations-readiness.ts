export type ConnectionState = 'loading' | 'unavailable' | 'helper-offline' | 'browser-unknown' | 'browser-offline' | 'connected';

export function operationNeedsBrowser(capabilityId: string): boolean {
  return !['start-browser', 'cdp-check', 'list-tabs'].includes(capabilityId);
}

export function connectionState(context: { helper: { is_online: boolean } | null; session?: { cdp_connected?: boolean } | null } | null, unavailable: boolean): ConnectionState {
  if (unavailable) return 'unavailable';
  if (!context) return 'loading';
  if (!context.helper?.is_online) return 'helper-offline';
  if (!context.session) return 'browser-unknown';
  if (context.session.cdp_connected === true) return 'connected';
  return context.session.cdp_connected === false ? 'browser-offline' : 'browser-unknown';
}

export function isWebUrl(value: string): boolean {
  try { return ['https:', 'http:'].includes(new URL(value.trim()).protocol); }
  catch { return false; }
}

export async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error(`${fallback} The server returned an unreadable response. Retry in a moment.`); }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? (value as { error?: unknown }).error : null;
    throw new Error(typeof error === 'string' && error ? error : `${fallback} (HTTP ${response.status}). Retry in a moment.`);
  }
  if (!value || typeof value !== 'object') throw new Error(`${fallback} The server returned an empty response. Retry in a moment.`);
  return value as T;
}
