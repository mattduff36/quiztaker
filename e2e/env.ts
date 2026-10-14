import { readFileSync } from 'node:fs';

const REQUIRED = [
  'DATABASE_URL=',
  'NEON_AUTH_BASE_URL=',
  'NEON_AUTH_COOKIE_SECRET=',
  'ALLOWED_EMAIL=',
  'HELPER_MASTER_KEY=',
];

export function localEnvReady(): boolean {
  try {
    const text = readFileSync('.env.local', 'utf8');
    return REQUIRED.every((key) => new RegExp(`^${key}`, 'm').test(text));
  } catch {
    return false;
  }
}
