import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

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
  const supabase = createSupabaseAdminClient();
  const rows = parsed.data.history.map((item) => ({
    user_id: helper.userId,
    helper_id: helper.helperId,
    source_id: item.sourceId,
    kind: item.kind,
    title: item.title,
    result: item.result,
    detail: item.detail,
    occurred_at: item.occurredAt,
    payload: item.payload,
  }));
  if (rows.length) {
    const { error } = await supabase.from('history_events').upsert(rows, {
      onConflict: 'user_id,helper_id,source_id',
      ignoreDuplicates: true,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, imported: rows.length });
}
