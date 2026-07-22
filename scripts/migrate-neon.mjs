import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = join(repositoryRoot, 'database', 'migrations');
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');

const sql = postgres(connectionString, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 15,
  prepare: false,
  ssl: 'require',
});

try {
  await sql`
    create table if not exists quiztaker_schema_migrations (
      name text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `;
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const contents = await readFile(join(migrationsDirectory, file), 'utf8');
    const hash = createHash('sha256').update(contents).digest('hex');
    const [existing] = await sql`
      select sha256 from quiztaker_schema_migrations where name = ${file}
    `;
    if (existing) {
      if (existing.sha256 !== hash) throw new Error(`Applied migration changed: ${file}`);
      console.log(`already applied ${file}`);
      continue;
    }
    await sql.begin(async (transaction) => {
      await transaction.unsafe(contents);
      await transaction`
        insert into quiztaker_schema_migrations (name, sha256)
        values (${file}, ${hash})
      `;
    });
    console.log(`applied ${file}`);
  }
} finally {
  await sql.end();
}
