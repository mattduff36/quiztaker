import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { compareVersions, getLatestHelperRelease } from '@/lib/releases';
import { queryOne, queryRows } from '@/lib/db';

const schema = z.object({
  status: z.enum(['online', 'busy']),
  activeJobId: z.string().uuid().optional(),
  version: z.string().min(1).max(50),
  cdpPort: z.number().int().min(1024).max(65535),
  protocolVersion: z.number().int().min(1).max(100).optional(),
  capabilities: z.array(z.object({
    id: z.string().min(1).max(80),
    version: z.number().int().positive(),
  })).max(50).optional(),
  supportsSelfUpdate: z.boolean().optional(),
  updateError: z.string().max(500).optional(),
});

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export async function POST(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat' }, { status: 400 });
  const reportedVersion = parsed.data.version;
  const row = await queryOne<{
    update_requested_version: string | null;
    update_requested_at: unknown;
    supports_self_update: boolean;
  }>(
    `update helpers
     set status = $2, active_job_id = $3, version = $4, cdp_port = $5,
         protocol_version = $6, supported_capabilities = $7::jsonb,
         supports_self_update = $8, update_error = coalesce($9, update_error),
         last_seen_at = now()
     where id = $1
     returning update_requested_version, update_requested_at, supports_self_update`,
    [
      helper.helperId,
      parsed.data.status,
      parsed.data.activeJobId ?? null,
      reportedVersion,
      parsed.data.cdpPort,
      parsed.data.protocolVersion ?? 1,
      JSON.stringify(parsed.data.capabilities ?? []),
      parsed.data.supportsSelfUpdate === true,
      parsed.data.updateError ?? null,
    ],
  );

  let requestedVersion = row?.update_requested_version ?? null;
  let requestedAt = row?.update_requested_at ?? null;
  if (requestedVersion && compareVersions(reportedVersion, requestedVersion) >= 0) {
    await queryRows(
      `update helpers
       set update_requested_version = null, update_requested_at = null, update_error = null
       where id = $1`,
      [helper.helperId],
    );
    requestedVersion = null;
    requestedAt = null;
  }

  const update = row?.supports_self_update
    ? await pendingUpdate(helper.helperId, reportedVersion, requestedVersion, requestedAt)
    : null;
  return NextResponse.json({ ok: true, minimumProtocolVersion: 2, update });
}

async function pendingUpdate(
  helperId: string,
  currentVersion: string,
  requestedVersion: string | null,
  requestedAt: unknown,
): Promise<{
  version: string;
  requestedAt: string;
  downloadUrl: string;
  sha256: string;
  installerUrl: string | null;
  installerSha256: string | null;
} | null> {
  if (!requestedVersion || !requestedAt) return null;
  const release = await getLatestHelperRelease().catch(() => null);
  if (!release || !RELEASE_VERSION.test(release.version) || !SHA256.test(release.sha256)) return null;
  if (compareVersions(release.version, currentVersion) <= 0) return null;
  if (compareVersions(release.version, requestedVersion) < 0) return null;

  let offeredAt = isoTimestamp(requestedAt);
  if (release.version !== requestedVersion) {
    const bumped = await queryOne<{ update_requested_at: unknown }>(
      `update helpers
       set update_requested_version = $2, update_requested_at = now(), update_error = null
       where id = $1
       returning update_requested_at`,
      [helperId, release.version],
    );
    if (!bumped?.update_requested_at) return null;
    offeredAt = isoTimestamp(bumped.update_requested_at);
  }

  return {
    version: release.version,
    requestedAt: offeredAt,
    downloadUrl: release.downloadUrl,
    sha256: release.sha256.toLowerCase(),
    installerUrl: release.installerUrl,
    installerSha256: release.installerSha256 ? release.installerSha256.toLowerCase() : null,
  };
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}
