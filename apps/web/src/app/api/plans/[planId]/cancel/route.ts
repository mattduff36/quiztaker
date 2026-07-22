import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows } from '@/lib/db';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { planId } = await context.params;
  const data = await queryOne<{ attempt_id: string }>(
    `update plans set consumed = true
     where id = $1 and user_id = $2 and consumed = false
     returning attempt_id`,
    [planId, user.id],
  );
  if (!data) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
  await queryRows(
    `insert into attempt_events (user_id, attempt_id, event, data)
     values
       ($1, $2, 'plan-cancelled', $3::jsonb),
       ($1, $2, 'attempt-finished', $4::jsonb)`,
    [
      user.id,
      data.attempt_id,
      JSON.stringify({ planId }),
      JSON.stringify({ outcome: 'cancelled', verified: false, status: 'cancelled-by-user' }),
    ],
  );
  return NextResponse.json({ ok: true });
}
