import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, withTransaction } from '@/lib/db';
import {
  exceedsByteLimit,
  llmCredentialKey,
  loadSecretLlmConnection,
  prepareConnectionSave,
  readPublicLlmConnection,
  readSettingsBody,
  type LlmProviderId,
} from '@/lib/llm-provider';
import { hasValidRequestOrigin } from '@/lib/security';

const saveSchema = z.object({
  action: z.literal('save'),
  provider: z.enum(['openai', 'gemini', 'openrouter']),
  model: z.string().max(80),
  apiKey: z.string().max(512).optional(),
});

const disconnectSchema = z.object({
  action: z.literal('disconnect'),
});

export async function POST(request: Request) {
  try { return await handlePost(request); } catch {
    return NextResponse.json({ error: 'Could not update the AI connection. Please try again.' }, { status: 503 });
  }
}

async function handlePost(request: Request) {
  if (!hasValidRequestOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && exceedsByteLimit(contentLength)) {
    return NextResponse.json({ error: 'Connection settings are too large' }, { status: 413 });
  }
  const raw = await readSettingsBody(request);
  if (raw === null) {
    return NextResponse.json({ error: 'Connection settings are too large' }, { status: 413 });
  }
  const body = parseJson(raw);
  const disconnect = disconnectSchema.safeParse(body);
  if (disconnect.success) return disconnectConnection(user.id);
  const save = saveSchema.safeParse(body);
  if (!save.success) return NextResponse.json({ error: 'Invalid connection settings' }, { status: 400 });
  return saveConnection(user.id, save.data.provider, save.data.model, save.data.apiKey ?? '');
}

async function saveConnection(userId: string, provider: LlmProviderId, model: string, apiKey: string) {
  let credentialKey: Buffer;
  try {
    credentialKey = llmCredentialKey(process.env.LLM_CREDENTIAL_KEY);
  } catch {
    return NextResponse.json({ error: 'Hosted AI credential storage is not configured' }, { status: 503 });
  }
  const reservation = await queryOne<{ request_id: string }>(
    `insert into llm_connection_tests (user_id) values ($1)
     on conflict (user_id) do update set request_id = gen_random_uuid(), requested_at = now()
     where llm_connection_tests.user_id = $1
       and llm_connection_tests.requested_at < now() - interval '30 seconds'
     returning request_id`, [userId],
  );
  if (!reservation) return NextResponse.json({ error: 'Wait 30 seconds before testing again.' }, { status: 429 });
  const stored = await loadSecretLlmConnection(userId);
  const prepared = await prepareConnectionSave({
    userId,
    provider,
    model,
    apiKey,
    stored,
    credentialKey,
  });
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 400 });
  const saved = prepared.record;
  try {
    const accepted = await withTransaction(async (sql) => {
      const [current] = await sql<{ request_id: string }>(
        'select request_id from llm_connection_tests where user_id = $1 for update', [userId],
      );
      if (current?.request_id !== reservation.request_id) return false;
      await sql(
      `insert into llm_connections (
         user_id, provider, model, ciphertext, iv, auth_tag, tested_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, now(), now())
       on conflict (user_id) do update set
         provider = excluded.provider,
         model = excluded.model,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         tested_at = now(),
         updated_at = now()
       where llm_connections.user_id = $1`,
      [userId, saved.provider, saved.model, saved.ciphertext, saved.iv, saved.authTag],
      );
      return true;
    });
    if (!accepted) return NextResponse.json({ error: 'Connection settings changed during the test. Please try again.' }, { status: 409 });
    return NextResponse.json(await readPublicLlmConnection(userId));
  } catch {
    return NextResponse.json({ error: 'Could not save the connection' }, { status: 500 });
  }
}

async function disconnectConnection(userId: string) {
  try {
    await withTransaction(async (sql) => {
      await sql(
        `insert into llm_connection_tests (user_id) values ($1)
         on conflict (user_id) do update set request_id = gen_random_uuid(), requested_at = now()
         where llm_connection_tests.user_id = $1`, [userId],
      );
      await sql(
      `insert into llm_connections (
         user_id, provider, model, ciphertext, iv, auth_tag, tested_at, updated_at
       ) values ($1, 'disabled', '', null, null, null, null, now())
       on conflict (user_id) do update set
         provider = 'disabled',
         model = '',
         ciphertext = null,
         iv = null,
         auth_tag = null,
         tested_at = null,
         updated_at = now()
       where llm_connections.user_id = $1`,
      [userId],
      );
    });
    return NextResponse.json(await readPublicLlmConnection(userId));
  } catch {
    return NextResponse.json({ error: 'Could not disconnect the connection' }, { status: 500 });
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
