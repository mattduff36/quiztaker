import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function GET(
  _request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { artifactId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data: artifact } = await supabase.from('artifacts').select('storage_path')
    .eq('id', artifactId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  const { data, error } = await supabase.storage
    .from('private-artifacts')
    .createSignedUrl(artifact.storage_path, 60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ url: data.signedUrl, expiresIn: 60 });
}
