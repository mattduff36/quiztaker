import { neon, Pool, type NeonQueryFunction } from '@neondatabase/serverless';
import { getServerEnv } from '@/lib/env';

let client: NeonQueryFunction<boolean, boolean> | null = null;
let pool: Pool | null = null;

export type SqlQuery = <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;

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

export async function withTransaction<T>(fn: (query: SqlQuery) => Promise<T>): Promise<T> {
  const connection = await getPool().connect();
  try {
    await connection.query('begin');
    const result = await fn(async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => {
      const queryResult = await connection.query(text, values);
      return queryResult.rows as T[];
    });
    await connection.query('commit');
    return result;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: getServerEnv().DATABASE_URL });
  return pool;
}
