import { NextResponse } from 'next/server';
import { getServerEnv } from '@/lib/env';
import { isTrustedBrowserDownload } from '@/lib/helper-update';
import { getLatestHelperRelease } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const release = await getLatestHelperRelease({ fresh: true });
  if (!release) {
    return NextResponse.json(
      { error: 'No published helper release is currently available.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const repository = getServerEnv().GITHUB_REPOSITORY;
  const asset = new URL(request.url).searchParams.get('asset');
  const preferred = asset === 'installer' ? release.installerUrl : null;
  const target = preferred && isTrustedBrowserDownload(preferred, repository)
    ? preferred
    : release.downloadUrl;
  if (!isTrustedBrowserDownload(target, repository)) {
    return NextResponse.json(
      { error: 'The published helper download is not a trusted release asset.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.redirect(target, {
    status: 307,
    headers: { 'Cache-Control': 'no-store' },
  });
}
