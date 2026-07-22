import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { queryRows } from '@/lib/db';

const historyEvent = z.object({
  sourceId: z.string().min(1).max(500),
  kind: z.string().min(1).max(50),
  title: z.string().min(1).max(1000),
  result: z.string().max(500),
  detail: z.string().max(3000).default(''),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const schema = z.object({
  history: z.array(historyEvent).max(500),
});

export async function POST(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid sync payload' }, { status: 400 });
  if (parsed.data.history.length) {
    await queryRows(
      `insert into history_events (
         user_id, helper_id, source_id, kind, title, result, detail, occurred_at, payload
       )
       select
         $1,
         $2,
         item.source_id,
         item.kind,
         item.title,
         item.result,
         item.detail,
         item.occurred_at,
         item.payload
       from jsonb_to_recordset($3::jsonb) as item(
         source_id text,
         kind text,
         title text,
         result text,
         detail text,
         occurred_at timestamptz,
         payload jsonb
       )
       on conflict (user_id, helper_id, source_id) do nothing`,
      [
        helper.userId,
        helper.helperId,
        JSON.stringify(parsed.data.history.map((item) => ({
          source_id: item.sourceId,
          kind: item.kind,
          title: item.title,
          result: item.result,
          detail: item.detail,
          occurred_at: item.occurredAt,
          payload: item.payload,
        }))),
      ],
    );
  }
  return NextResponse.json({ ok: true, imported: parsed.data.history.length });
}
