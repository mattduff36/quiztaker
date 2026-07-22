import { NextResponse } from 'next/server';
import { authenticateHelper } from '@/lib/security';
import { getLatestHelperRelease } from '@/lib/releases';

export async function GET(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  return NextResponse.json({ release: await getLatestHelperRelease() });
}
