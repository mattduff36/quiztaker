import { NextResponse } from 'next/server';
import { getServerEnv } from '@/lib/env';
import { getAuth } from '@/lib/neon-auth/server';
import { hasValidRequestOrigin } from '@/lib/security';

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return getAuth().handler().GET(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!hasValidRequestOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  const pathname = new URL(request.url).pathname;
  if (pathname.includes('/sign-up/') || pathname.includes('/sign-in/')) {
    const body = await request.clone().json().catch(() => null) as { email?: string } | null;
    if (body?.email?.toLowerCase() !== getServerEnv().ALLOWED_EMAIL.toLowerCase()) {
      return NextResponse.json({ error: 'This account is not authorized' }, { status: 403 });
    }
  }
  return getAuth().handler().POST(request, context);
}
