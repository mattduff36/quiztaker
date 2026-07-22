import { NextResponse } from 'next/server';
import { getLatestHelperRelease } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export async function GET() {
  const release = await getLatestHelperRelease();
  if (!release) {
    return NextResponse.json(
      { error: 'No published helper release is currently available.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.redirect(release.downloadUrl, {
    status: 307,
    headers: { 'Cache-Control': 'no-store' },
  });
}
