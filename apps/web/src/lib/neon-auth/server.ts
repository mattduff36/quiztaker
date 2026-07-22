import { createNeonAuth } from '@neondatabase/auth/next/server';
import { getServerEnv } from '@/lib/env';

let auth: ReturnType<typeof createNeonAuth> | null = null;

export function getAuth() {
  if (auth) return auth;
  const env = getServerEnv();
  auth = createNeonAuth({
    baseUrl: env.NEON_AUTH_BASE_URL,
    cookies: {
      secret: env.NEON_AUTH_COOKIE_SECRET,
      sessionDataTtl: 300,
    },
    logLevel: 'warn',
  });
  return auth;
}
