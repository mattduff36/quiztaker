import { NextResponse } from 'next/server';
import { capabilityManifest } from '@quiztaker/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows } from '@/lib/db';
import { describeHelperUpdate } from '@/lib/helper-update';
import { parityEnabled } from '@/lib/parity';
import { getLatestHelperRelease } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const helper = await queryOne<Record<string, unknown>>(
    `select presence.id, presence.device_name, presence.version, presence.is_online, presence.status,
            presence.protocol_version, presence.supported_capabilities,
            helpers.supports_self_update, helpers.update_requested_version, helpers.update_error
     from helper_presence presence
     join helpers on helpers.id = presence.id
     where presence.user_id = $1 and presence.revoked_at is null
     order by presence.last_seen_at desc nulls last
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
  const release = await getLatestHelperRelease().catch(() => null);
  const helperUpdate = describeHelperUpdate({
    currentVersion: String(helper.version ?? '0.0.0'),
    protocolVersion: Number(helper.protocol_version ?? 1),
    supportsSelfUpdate: helper.supports_self_update === true,
    requestedVersion: typeof helper.update_requested_version === 'string' ? helper.update_requested_version : null,
    error: typeof helper.update_error === 'string' ? helper.update_error : null,
    release,
  });
  return NextResponse.json({
    helper,
    helperUpdate,
    session,
    recentUrls,
    activeJob,
    captures,
    parityEnabled: parityEnabled(),
    capabilities: capabilityManifest(),
  });
}
