import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createPairingCode, hashPairingCodeForOrigin } from '@/lib/pairing-code';
import { hasValidRequestOrigin } from '@/lib/security';
import { queryRows } from '@/lib/db';

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const controlPlaneUrl = new URL(request.url).origin;
  const code = createPairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await queryRows(
    'delete from pairing_codes where user_id = $1 and claimed_at is null',
    [user.id],
  );
  await queryRows(
    `insert into pairing_codes (user_id, code_hash, expires_at)
     values ($1, $2, $3)`,
    [user.id, hashPairingCodeForOrigin(code, controlPlaneUrl), expiresAt],
  );
  return NextResponse.json({ code, expiresAt, controlPlaneUrl });
}
