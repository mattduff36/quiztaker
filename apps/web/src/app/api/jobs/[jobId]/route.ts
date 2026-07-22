import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { hasValidRequestOrigin } from '@/lib/security';

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const [{ data: job, error }, { data: events }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', jobId).eq('user_id', user.id).maybeSingle(),
    supabase.from('job_events').select('sequence,event,data,occurred_at').eq('job_id', jobId).eq('user_id', user.id).order('sequence'),
  ]);
  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({ job, events: events ?? [] });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data: current } = await supabase
    .from('jobs')
    .select('id,status,attempt_id')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .in('status', ['queued', 'dispatched', 'running'])
    .maybeSingle();
  if (!current) return NextResponse.json({ error: 'Active job not found' }, { status: 404 });
  const update = current.status === 'queued'
    ? {
        cancel_requested: true,
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        outcome: { outcome: 'cancelled', verified: false, status: 'cancelled-before-dispatch' },
      }
    : { cancel_requested: true };
  const { error } = await supabase.from('jobs').update(update).eq('id', jobId).eq('status', current.status);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (current.status === 'queued') {
    await supabase.from('attempt_events').insert({
      user_id: user.id,
      attempt_id: current.attempt_id,
      event: 'attempt-finished',
      data: { outcome: 'cancelled', verified: false, status: 'cancelled-before-dispatch', jobId },
    });
  }
  return NextResponse.json({ ok: true });
}
