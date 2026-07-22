import { z } from 'zod';

const serverSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  NEON_AUTH_BASE_URL: z.string().url(),
  NEON_AUTH_COOKIE_SECRET: z.string().min(32),
  ALLOWED_EMAIL: z.string().email(),
  HELPER_MASTER_KEY: z.string().min(32),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  GITHUB_REPOSITORY: z.string().default('mattduff36/quiztaker'),
});

export function getServerEnv() {
  return serverSchema.parse(process.env);
}
