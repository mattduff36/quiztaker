import { z } from 'zod';

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ALLOWED_EMAIL: z.string().email(),
  HELPER_MASTER_KEY: z.string().min(32),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  GITHUB_REPOSITORY: z.string().default('mattduff36/quiztaker'),
});

export function getServerEnv() {
  return serverSchema.parse(process.env);
}

export function getPublicEnv() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  };
}
