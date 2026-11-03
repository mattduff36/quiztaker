import { queryRows, type SqlQuery } from '@/lib/db';

/** Recognise transport evidence, never an ordinary course navigation failure. */
export function browserConnectionLost(output: string, capabilityId: string, result?: unknown): boolean {
  if (/(?:^|\n)browserType\.connectOverCDP:[^\n]*(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|closed|timed out|Timeout)/i.test(output)) return true;
  if (!['cdp-check', 'start-browser'].includes(capabilityId) || !result || typeof result !== 'object') return false;
  const envelope = result as Record<string, unknown>;
  const body = envelope.result && typeof envelope.result === 'object' ? envelope.result as Record<string, unknown> : envelope;
  return body.connected === false;
}

export async function invalidateBrowserConnection(input: {
  userId: string; helperId: string; jobCreatedAt: string | Date;
}, query: SqlQuery = queryRows): Promise<void> {
  // A delayed failure must not overwrite a newer successful reconnect/snapshot.
  await query(`update browser_sessions
    set cdp_connected = false, tabs = '[]'::jsonb, roster = null, detection = null, updated_at = now()
    where user_id = $1 and helper_id = $2 and closed_at is null and updated_at <= $3::timestamptz`,
  [input.userId, input.helperId, input.jobCreatedAt]);
}
