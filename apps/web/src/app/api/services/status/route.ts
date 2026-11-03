import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { readPublicLlmConnection } from '@/lib/llm-provider';
import type { ServiceStatusSnapshot } from '@/lib/service-status';
import { MAINTENANCE_CAPABILITIES } from '@/lib/task-completion';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

/** Read presence without queuing probes, recovering jobs or renewing operator activity. */
export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
    const [presence, assistant] = await Promise.all([
      queryOne<{ is_online: boolean; last_seen_at: string | null; cdp_connected: boolean | null; browser_checked_at: string | null; task_active: boolean }>(
        `select h.is_online, h.last_seen_at, b.cdp_connected, b.updated_at as browser_checked_at,
          coalesce(t.status in ('queued','dispatched','running','awaiting-input'),false) as task_active
         from helper_presence h
         left join lateral (
           select cdp_connected, updated_at from browser_sessions
           where user_id = $1 and helper_id = h.id and closed_at is null
           order by updated_at desc limit 1
         ) b on true
         left join lateral (
           select status from jobs where user_id=$1 and helper_id=h.id
           and not(capability_id=any($2::text[]))
           order by created_at desc,id desc limit 1
         ) t on true
         where h.user_id = $1 and h.revoked_at is null
         order by h.last_seen_at desc nulls last limit 1`, [user.id, MAINTENANCE_CAPABILITIES]),
      readPublicLlmConnection(user.id),
    ]);
    const snapshot: ServiceStatusSnapshot = {
      checkedAt: new Date().toISOString(),
      helper: presence ? { online: presence.is_online === true, lastSeenAt: presence.last_seen_at } : null,
      browser: presence?.cdp_connected != null ? { connected: presence.cdp_connected === true, checkedAt: presence.browser_checked_at } : null,
      assistant: { ready: assistant.ready, source: assistant.source, provider: assistant.provider },
      activity: { session: presence?.is_online === true && presence?.cdp_connected === true, task: presence?.task_active === true },
    };
    return NextResponse.json(snapshot, { headers });
  } catch {
    return NextResponse.json({ error: 'Service status is unavailable.' }, { status: 503, headers });
  }
}
