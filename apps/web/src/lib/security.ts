import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveHelperSecret } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export function createPairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

export function hashPairingCode(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code)).digest('hex');
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

export function hasValidRequestOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function authenticateHelper(request: Request) {
  const helperId = request.headers.get('x-helper-id');
  const authorization = request.headers.get('authorization');
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!helperId || !supplied) return null;

  const expected = deriveHelperSecret(getServerEnv().HELPER_MASTER_KEY, helperId);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('helpers')
    .select('id,user_id,status')
    .eq('id', helperId)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data || data.status === 'revoked') return null;
  return { helperId: data.id as string, userId: data.user_id as string };
}
