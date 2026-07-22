import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
