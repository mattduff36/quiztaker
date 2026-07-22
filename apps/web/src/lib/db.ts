import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { getServerEnv } from '@/lib/env';

let client: NeonQueryFunction<boolean, boolean> | null = null;

export function getDatabase() {
  if (!client) client = neon(getServerEnv().DATABASE_URL);
  return client;
}

export async function queryRows<T>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return getDatabase().query(text, values) as Promise<T[]>;
}

export async function queryOne<T>(
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(text, values);
  return rows[0] ?? null;
}
