import { get } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { artifactId } = await context.params;
  const artifact = await queryOne<{ pathname: string }>(
    `select pathname from artifacts where id = $1 and user_id = $2`,
    [artifactId, user.id],
  );
  if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  const result = await get(artifact.pathname, {
    access: 'private',
    ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
  });
  if (!result) return new NextResponse('Not found', { status: 404 });
  if (result.statusCode === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: result.blob.etag,
        'Cache-Control': 'private, no-cache',
      },
    });
  }
  return new NextResponse(result.stream, {
    headers: {
      'Content-Type': result.blob.contentType,
      'X-Content-Type-Options': 'nosniff',
      ETag: result.blob.etag,
      'Cache-Control': 'private, no-cache',
    },
  });
}
