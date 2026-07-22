import { NextResponse } from 'next/server';
import { claimNextJob } from '@/lib/jobs';
import { authenticateHelper } from '@/lib/security';

export async function GET(request: Request) {
  const helper = await authenticateHelper(request);
  if (!helper) return NextResponse.json({ error: 'Unauthorized helper' }, { status: 401 });
  try {
    return NextResponse.json({ job: await claimNextJob(helper.helperId, helper.userId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not poll jobs' }, { status: 500 });
  }
}
