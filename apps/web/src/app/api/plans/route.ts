import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { createPlan } from '@/lib/plans';
import { hasValidRequestOrigin } from '@/lib/security';

const schema = z.object({
  helperId: z.string().uuid(),
  capabilityId: z.string().min(1),
  args: z.array(z.string()).max(100).optional(),
  label: z.string().max(200).optional(),
  steps: z.array(z.string()).max(30).optional(),
  targets: z.array(z.object({
    id: z.string().optional(),
    title: z.string().min(1).max(500),
  })).max(100).optional(),
  evidence: z.array(z.string().max(1000)).max(50).optional(),
  confidence: z.number().min(0).max(1).optional(),
  fingerprint: z.string().max(200).nullable().optional(),
  tabIdx: z.number().int().min(0).nullable().optional(),
});

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid plan', issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(await createPlan(user.id, parsed.data), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create plan' }, { status: 400 });
  }
}
