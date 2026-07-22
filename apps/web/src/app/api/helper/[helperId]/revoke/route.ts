import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(
  request: Request,
  context: { params: Promise<{ helperId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { helperId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase.from('helpers').update({
    status: 'revoked',
    revoked_at: new Date().toISOString(),
  }).eq('id', helperId).eq('user_id', user.id).select('id').maybeSingle();
  if (!data) return NextResponse.json({ error: 'Helper not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
