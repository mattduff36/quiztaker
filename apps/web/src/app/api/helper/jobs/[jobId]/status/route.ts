import { NextResponse } from 'next/server';
import { authenticateHelper } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('jobs')
    .select('cancel_requested,status')
    .eq('id', jobId)
    .eq('helper_id', helper.helperId)
    .eq('user_id', helper.userId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({
    cancelRequested: data.cancel_requested,
    status: data.status,
  });
}
