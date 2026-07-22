import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { planId } = await context.params;
  const now = new Date().toISOString();
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('plans')
    .update({ confirmed: true, confirmed_at: now })
    .eq('id', planId)
    .eq('user_id', user.id)
    .eq('consumed', false)
    .gt('expires_at', now)
    .select('id,attempt_id')
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: 'Plan not found, consumed, or expired' }, { status: 404 });
  }
  await supabase.from('attempt_events').insert({
    user_id: user.id,
    attempt_id: data.attempt_id,
    event: 'plan-confirmed',
    data: { planId },
  });
  return NextResponse.json({ ok: true, planId });
}
