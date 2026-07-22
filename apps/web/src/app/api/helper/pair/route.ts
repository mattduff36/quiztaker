import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createPairingCode, hasValidRequestOrigin, hashPairingCode } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const code = createPairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const supabase = createSupabaseAdminClient();
  await supabase.from('pairing_codes').delete()
    .eq('user_id', user.id)
    .is('claimed_at', null);
  const { error } = await supabase.from('pairing_codes').insert({
    user_id: user.id,
    code_hash: hashPairingCode(code),
    expires_at: expiresAt,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ code, expiresAt });
}
