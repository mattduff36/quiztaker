import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(
  request: Request,
  context: { params: Promise<{ helperId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { helperId } = await context.params;
  const data = await queryOne<{ id: string }>(
    `update helpers set status = 'revoked', revoked_at = now()
     where id = $1 and user_id = $2
     returning id`,
    [helperId, user.id],
  );
  if (!data) return NextResponse.json({ error: 'Helper not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
