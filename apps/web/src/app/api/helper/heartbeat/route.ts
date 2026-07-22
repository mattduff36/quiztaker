import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const schema = z.object({
  status: z.enum(['online', 'busy']),
  activeJobId: z.string().uuid().optional(),
  version: z.string().min(1).max(50),
  cdpPort: z.number().int().min(1024).max(65535),
});

export async function POST(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat' }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('helpers').update({
    status: parsed.data.status,
    active_job_id: parsed.data.activeJobId ?? null,
    version: parsed.data.version,
    cdp_port: parsed.data.cdpPort,
    last_seen_at: new Date().toISOString(),
  }).eq('id', helper.helperId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
