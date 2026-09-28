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

const reviewEvent = z.object({
  sourceId: z.string().min(1).max(200),
  type: z.string().min(1).max(80),
  title: z.string().min(1).max(500),
  detail: z.string().max(3000).default(''),
  nextAction: z.string().max(1000).default(''),
});

const captureEvent = z.object({
  sourceId: z.string().min(1).max(200),
  fingerprint: z.string().max(200).nullable().optional(),
  title: z.string().min(1).max(500),
  detail: z.string().max(3000).default(''),
  capturedAt: z.string().datetime(),
  probe: z.record(z.string(), z.unknown()).default({}),
});

const schema = z.object({
  history: z.array(historyEvent).max(500).default([]),
  reviews: z.array(reviewEvent).max(200).default([]),
  captures: z.array(captureEvent).max(100).default([]),
  cursor: z.string().max(200).optional(),
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
  for (const review of parsed.data.reviews) {
    await queryRows(
      `insert into review_items (user_id, type, title, detail, next_action)
       select $1, $2, $3, $4, $5
       where not exists (
         select 1 from review_items
         where user_id = $1 and title = $3 and detail = $4 and status = 'open'
       )`,
      [helper.userId, review.type, review.title, review.detail, review.nextAction],
    );
  }
  for (const capture of parsed.data.captures) {
    await queryRows(
      `insert into learning_captures (
         user_id, helper_id, source_id, fingerprint, title, detail, probe, captured_at
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       on conflict (user_id, source_id) do nothing`,
      [
        helper.userId,
        helper.helperId,
        capture.sourceId,
        capture.fingerprint ?? null,
        capture.title,
        capture.detail,
        JSON.stringify(capture.probe),
        capture.capturedAt,
      ],
    );
  }
  if (parsed.data.cursor) {
    await queryRows(
      `insert into sync_cursors (user_id, helper_id, stream, cursor)
       values ($1, $2, 'legacy', $3)
       on conflict (helper_id, stream) do update set cursor = excluded.cursor, updated_at = now()`,
      [helper.userId, helper.helperId, parsed.data.cursor],
    );
  }
  return NextResponse.json({
    ok: true,
    imported: parsed.data.history.length + parsed.data.reviews.length + parsed.data.captures.length,
  });
}
