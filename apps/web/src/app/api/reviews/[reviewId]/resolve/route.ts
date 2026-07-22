import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { hasValidRequestOrigin } from '@/lib/security';

const schema = z.object({ resolution: z.string().min(1).max(2000) });

export async function POST(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Resolution is required' }, { status: 400 });
  const { reviewId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase.from('review_items').update({
    status: 'resolved',
    resolution: parsed.data.resolution,
    resolved_at: new Date().toISOString(),
  }).eq('id', reviewId).eq('user_id', user.id).eq('status', 'open').select('id').maybeSingle();
  if (!data) return NextResponse.json({ error: 'Review not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
