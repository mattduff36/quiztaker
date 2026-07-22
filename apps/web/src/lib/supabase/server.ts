import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/lib/env';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try {
          for (const value of values) cookieStore.set(value);
        } catch {
          // Server Components cannot write cookies. Route handlers and proxy can.
        }
      },
    },
  });
}
