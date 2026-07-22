import type { NextRequest } from 'next/server';
import { getAuth } from '@/lib/neon-auth/server';

export default function proxy(request: NextRequest) {
  return getAuth().middleware({ loginUrl: '/sign-in' })(request);
}

export const config = {
  matcher: [
    '/',
    '/helper/:path*',
    '/history/:path*',
    '/learning/:path*',
    '/docs/:path*',
    '/download/:path*',
    '/settings/:path*',
  ],
};
