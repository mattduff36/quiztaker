import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authenticateHelper } from '@/lib/security';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  const { jobId } = await context.params;
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: 'A file up to 50 MB is required' }, { status: 400 });
  }
  const supabase = createSupabaseAdminClient();
  const { data: job } = await supabase.from('jobs').select('id')
    .eq('id', jobId)
    .eq('helper_id', helper.helperId)
    .eq('user_id', helper.userId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  const safeName = file.name.replace(/[^a-z0-9._-]/gi, '-').slice(-150);
  const storagePath = `${helper.userId}/${jobId}/${hash.slice(0, 12)}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from('private-artifacts').upload(storagePath, bytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploadError && !/already exists/i.test(uploadError.message)) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }
  const { data: artifact, error } = await supabase.from('artifacts').upsert({
    user_id: helper.userId,
    helper_id: helper.helperId,
    job_id: jobId,
    storage_path: storagePath,
    media_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
    sha256: hash,
  }, { onConflict: 'storage_path' }).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ artifactId: artifact.id }, { status: 201 });
}
