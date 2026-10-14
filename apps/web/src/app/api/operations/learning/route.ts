import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { readLearnerSessionForOperator } from '@/lib/learner-memory';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  helperId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
});

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');
  const parsed = querySchema.safeParse({
    helperId: url.searchParams.get('helperId') ?? undefined,
    ...(sessionId ? { sessionId } : {}),
  });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid learning query' }, { status: 400 });
  const helper = await queryOne<{ id: string }>(
    `select id from helpers where id = $1 and user_id = $2 and revoked_at is null`,
    [parsed.data.helperId, user.id],
  );
  if (!helper) return NextResponse.json({ error: 'Helper not found' }, { status: 404 });
  const session = await readLearnerSessionForOperator({
    userId: user.id,
    helperId: parsed.data.helperId,
    browserSessionId: parsed.data.sessionId ?? null,
  });
  if (!session) return NextResponse.json({ id: null, objective: null, history: [] });
  return NextResponse.json(session);
}
