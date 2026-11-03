import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne, queryRows } from '@/lib/db';
import { hasValidRequestOrigin } from '@/lib/security';
import { requestHelperJobCancellation } from '@/lib/job-recovery';

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
  const job = await queryOne<{ helper_id: string }>(
    'select helper_id from jobs where id = $1 and user_id = $2',
    [jobId, user.id],
  );
  if (!job) return NextResponse.json({ error: 'Active job not found' }, { status: 404 });
  const requested = await requestHelperJobCancellation({ userId: user.id, helperId: job.helper_id, jobId });
  if (!requested) return NextResponse.json({ error: 'Active job not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
