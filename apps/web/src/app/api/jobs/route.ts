import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { createJob } from '@/lib/jobs';
import { hasValidRequestOrigin } from '@/lib/security';

const schema = z.object({ planId: z.string().uuid() });

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid job request' }, { status: 400 });
  try {
    return NextResponse.json(await createJob(user.id, parsed.data.planId), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create job' }, { status: 409 });
  }
}
