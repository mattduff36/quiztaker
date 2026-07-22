import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows } from '@/lib/db';
import { hasValidRequestOrigin } from '@/lib/security';

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const [job, events] = await Promise.all([
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
  ]);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({ job, events });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const current = await queryOne<{ status: string; attempt_id: string }>(
    `select status, attempt_id
     from jobs
     where id = $1 and user_id = $2 and status in ('queued', 'dispatched', 'running')`,
    [jobId, user.id],
  );
  if (!current) return NextResponse.json({ error: 'Active job not found' }, { status: 404 });
  if (current.status === 'queued') {
    const outcome = { outcome: 'cancelled', verified: false, status: 'cancelled-before-dispatch' };
    await queryRows(
      `update jobs
       set cancel_requested = true, status = 'cancelled', finished_at = now(), outcome = $3::jsonb
       where id = $1 and user_id = $2 and status = 'queued'`,
      [jobId, user.id, JSON.stringify(outcome)],
    );
    await queryRows(
      `insert into attempt_events (user_id, attempt_id, event, data)
       values ($1, $2, 'attempt-finished', $3::jsonb)`,
      [user.id, current.attempt_id, JSON.stringify({ ...outcome, jobId })],
    );
  } else {
    await queryRows(
      `update jobs set cancel_requested = true
       where id = $1 and user_id = $2 and status = $3`,
      [jobId, user.id, current.status],
    );
  }
  return NextResponse.json({ ok: true });
}
