import { NextResponse } from 'next/server';
import { authenticateHelper } from '@/lib/security';
import { queryOne } from '@/lib/db';

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const { jobId } = await context.params;
  const data = await queryOne<{ cancel_requested: boolean; status: string }>(
    `select cancel_requested, status
     from jobs
     where id = $1 and helper_id = $2 and user_id = $3`,
    [jobId, helper.helperId, helper.userId],
  );
  if (!data) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({
    cancelRequested: data.cancel_requested,
    status: data.status,
  });
}
