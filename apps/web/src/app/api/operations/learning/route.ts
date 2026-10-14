import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { appendLearnerGuidance, displayLearnerHistory, readLearnerSessionForOperator } from '@/lib/learner-memory';
import { hasValidRequestOrigin } from '@/lib/security';

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

const guidanceSchema = z.object({
  helperId: z.string().uuid(),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  requestId: z.string().uuid(),
  text: z.string().max(16_000),
});

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = guidanceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid learning guidance' }, { status: 400 });
  const helper = await queryOne<{ id: string }>(
    `select id from helpers where id = $1 and user_id = $2 and revoked_at is null`,
    [parsed.data.helperId, user.id],
  );
  if (!helper) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const browser = await queryOne<{ id: string }>(
    `select id from browser_sessions
     where id = $1 and user_id = $2 and helper_id = $3 and closed_at is null`,
    [parsed.data.sessionId, user.id, parsed.data.helperId],
  );
  if (!browser) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const saved = await appendLearnerGuidance({
      userId: user.id,
      helperId: parsed.data.helperId,
      browserSessionId: parsed.data.sessionId,
      conversationId: parsed.data.conversationId,
      requestId: parsed.data.requestId,
      text: parsed.data.text,
    });
    return NextResponse.json({
      id: saved.id,
      objective: saved.objective,
      history: displayLearnerHistory(saved.history),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Learner conversation was not found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (message === 'Learner guidance is invalid' || message === 'Learner guidance request id is invalid') {
      return NextResponse.json({ error: 'Invalid learning guidance' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Learning guidance could not be saved' }, { status: 500 });
  }
}
