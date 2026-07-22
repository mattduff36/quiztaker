import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { queryRows } from '@/lib/db';

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
  await queryRows(
    `update helpers
     set status = $2, active_job_id = $3, version = $4, cdp_port = $5, last_seen_at = now()
     where id = $1`,
    [
      helper.helperId,
      parsed.data.status,
      parsed.data.activeJobId ?? null,
      parsed.data.version,
      parsed.data.cdpPort,
    ],
  );
  return NextResponse.json({ ok: true });
}
