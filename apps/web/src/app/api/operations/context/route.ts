import { NextResponse } from 'next/server';
import { capabilityManifest } from '@quiztaker/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows } from '@/lib/db';
import { parityEnabled } from '@/lib/parity';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const helper = await queryOne<Record<string, unknown>>(
    `select id, device_name, version, is_online, status, protocol_version, supported_capabilities
     from helper_presence
     where user_id = $1 and revoked_at is null
     order by last_seen_at desc nulls last
     limit 1`,
    [user.id],
  );
  if (!helper) {
    return NextResponse.json({ helper: null, parityEnabled: parityEnabled(), capabilities: capabilityManifest() });
  }
  const helperId = String(helper.id);
  const [session, recentUrls, activeJob, captures] = await Promise.all([
    queryOne(
      `select id, revision, cdp_connected, tabs, roster, detection
       from browser_sessions
       where user_id = $1 and helper_id = $2 and closed_at is null
       order by updated_at desc limit 1`,
      [user.id, helperId],
    ),
    queryRows(
      `select url, title, seen_count, last_seen_at
       from recent_urls
       where user_id = $1 and forgotten_at is null
       order by last_seen_at desc limit 40`,
      [user.id],
    ),
    queryOne(
      `select id, status, capability_id, outcome, diagnosis, result, output_url
       from jobs
       where user_id = $1 and helper_id = $2
       order by created_at desc limit 1`,
      [user.id, helperId],
    ),
    queryRows(
      `select id, title, fingerprint, captured_at
       from learning_captures
       where user_id = $1
       order by captured_at desc limit 8`,
      [user.id],
    ),
  ]);
  return NextResponse.json({
    helper,
    session,
    recentUrls,
    activeJob,
    captures,
    parityEnabled: parityEnabled(),
    capabilities: capabilityManifest(),
  });
}
