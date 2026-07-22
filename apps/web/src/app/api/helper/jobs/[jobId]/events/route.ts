import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordJobEvent } from '@/lib/jobs';
import { authenticateHelper } from '@/lib/security';

const schema = z.object({
  sequence: z.number().int().positive(),
  event: z.enum(['accepted', 'started', 'stdout', 'stderr', 'completed', 'failed', 'cancelled']),
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid job event' }, { status: 400 });
  const { jobId } = await context.params;
  try {
    await recordJobEvent(helper.helperId, helper.userId, jobId, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not record event' }, { status: 500 });
  }
}
