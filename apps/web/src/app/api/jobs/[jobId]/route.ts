import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows, withTransaction } from '@/lib/db';
import { hasValidRequestOrigin } from '@/lib/security';

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const [job, events, artifacts] = await Promise.all([
    queryOne<Record<string, unknown>>(
      'select * from jobs where id = $1 and user_id = $2',
      [jobId, user.id],
    ),
    queryRows<Record<string, unknown>>(
      `select sequence, event, data, occurred_at
       from job_events
       where job_id = $1 and user_id = $2
       order by sequence`,
      [jobId, user.id],
    ),
    queryRows(
      `select id, pathname, media_type, size_bytes
       from artifacts
       where job_id = $1 and user_id = $2
       order by created_at`,
      [jobId, user.id],
    ),
  ]);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({ job, events, artifacts });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const current = await withTransaction(async (sql) => {
    const [updated] = await sql<{ status: string; attempt_id: string }>(
      `update jobs set cancel_requested = true,
         status = case when status = 'queued' then 'cancelled' else status end,
         finished_at = case when status = 'queued' then now() else finished_at end,
         outcome = case when status = 'queued' then $3::jsonb else outcome end
       where id = $1 and user_id = $2 and status in ('queued', 'dispatched', 'running')
       returning status, attempt_id`,
      [jobId, user.id, JSON.stringify({ outcome: 'cancelled', verified: false, status: 'cancelled-before-dispatch' })],
    );
    if (updated?.status === 'cancelled') {
      await sql(
        `insert into attempt_events (user_id, attempt_id, event, data)
         values ($1, $2, 'attempt-finished', $3::jsonb)`,
        [user.id, updated.attempt_id, JSON.stringify({ outcome: 'cancelled', verified: false, status: 'cancelled-before-dispatch', jobId })],
      );
    }
    return updated;
  });
  if (!current) return NextResponse.json({ error: 'Active job not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
