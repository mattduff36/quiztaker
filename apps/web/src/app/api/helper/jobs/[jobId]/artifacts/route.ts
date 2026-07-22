import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { authenticateHelper } from '@/lib/security';

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
  const job = await queryOne<{ id: string }>(
    `select id from jobs where id = $1 and helper_id = $2 and user_id = $3`,
    [jobId, helper.helperId, helper.userId],
  );
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  const safeName = file.name.replace(/[^a-z0-9._-]/gi, '-').slice(-150);
  const pathname = `${helper.userId}/${jobId}/${hash.slice(0, 12)}-${safeName}`;
  const blob = await put(pathname, bytes, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: file.type || 'application/octet-stream',
  });
  const artifact = await queryOne<{ id: string }>(
    `insert into artifacts (
       user_id, helper_id, job_id, storage_url, pathname, media_type, size_bytes, sha256
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (storage_url) do update set
       size_bytes = excluded.size_bytes,
       sha256 = excluded.sha256
     returning id`,
    [
      helper.userId,
      helper.helperId,
      jobId,
      blob.url,
      blob.pathname,
      file.type || 'application/octet-stream',
      file.size,
      hash,
    ],
  );
  return NextResponse.json({ artifactId: artifact?.id }, { status: 201 });
}
