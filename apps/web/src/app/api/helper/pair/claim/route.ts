import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deriveHelperSecret } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { hashPairingCode, normalizePairingCode } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const schema = z.object({
  code: z.string().min(6).max(20),
  deviceName: z.string().min(1).max(200),
  platform: z.literal('win32'),
  architecture: z.enum(['x64', 'arm64']),
  version: z.string().min(1).max(50),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid pairing request' }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const { data: pairing } = await supabase
    .from('pairing_codes')
    .select('id,user_id')
    .eq('code_hash', hashPairingCode(normalizePairingCode(parsed.data.code)))
    .is('claimed_at', null)
    .gt('expires_at', now)
    .maybeSingle();
  if (!pairing) return NextResponse.json({ error: 'Pairing code is invalid or expired' }, { status: 404 });

  await supabase.from('helpers').update({
    status: 'revoked',
    revoked_at: now,
  }).eq('user_id', pairing.user_id).neq('device_name', parsed.data.deviceName).is('revoked_at', null);
  const { data: helper, error } = await supabase.from('helpers').upsert({
    user_id: pairing.user_id,
    device_name: parsed.data.deviceName,
    platform: parsed.data.platform,
    architecture: parsed.data.architecture,
    version: parsed.data.version,
    status: 'online',
    last_seen_at: now,
    revoked_at: null,
  }, { onConflict: 'user_id,device_name' }).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: claimed } = await supabase
    .from('pairing_codes')
    .update({ claimed_at: now, helper_id: helper.id })
    .eq('id', pairing.id)
    .is('claimed_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) return NextResponse.json({ error: 'Pairing code was already used' }, { status: 409 });
  return NextResponse.json({
    helperId: helper.id,
    deviceSecret: deriveHelperSecret(getServerEnv().HELPER_MASTER_KEY, helper.id),
  });
}
