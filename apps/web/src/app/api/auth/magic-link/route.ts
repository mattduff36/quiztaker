import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env';
import { hasValidRequestOrigin } from '@/lib/security';

const schema = z.object({ email: z.string().email() });

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  const env = getServerEnv();
  if (parsed.data.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
    return NextResponse.json({ error: 'This account is not authorized' }, { status: 403 });
  }
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const siteUrl = env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${siteUrl}/auth/callback`,
      shouldCreateUser: true,
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
