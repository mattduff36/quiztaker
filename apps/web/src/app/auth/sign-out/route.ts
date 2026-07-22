import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/neon-auth/server';
import { hasValidRequestOrigin } from '@/lib/security';

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
  await getAuth().signOut();
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
