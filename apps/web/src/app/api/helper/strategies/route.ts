import { NextResponse } from 'next/server';
import { authenticateHelper } from '@/lib/security';
import { queryOne, queryRows } from '@/lib/db';

export async function GET(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const rows = await queryRows<{
    id: string;
    capability_id: string;
    fingerprint: string | null;
    status: string;
    successes: number;
    failures: number;
    targets: string[];
    actions: unknown[];
    revision: number;
  }>(
    `select id, capability_id, fingerprint, status, successes, failures, targets, actions, revision
     from strategies where user_id = $1`,
    [helper.userId],
  );
  const revision = rows.reduce((max, row) => Math.max(max, Number(row.revision || 1)), 1);
  const strategies = Object.fromEntries(rows.map((row) => [row.id, {
    capabilityId: row.capability_id,
    fingerprint: row.fingerprint,
    status: row.status,
    successes: row.successes,
    failures: row.failures,
    targets: row.targets,
    actions: row.actions,
  }]));
  await queryOne(
    `insert into sync_cursors (user_id, helper_id, stream, cursor)
     values ($1, $2, 'strategies', $3)
     on conflict (helper_id, stream) do update set cursor = excluded.cursor, updated_at = now()`,
    [helper.userId, helper.helperId, String(revision)],
  );
  return NextResponse.json({ schemaVersion: 1, revision, strategies });
}
