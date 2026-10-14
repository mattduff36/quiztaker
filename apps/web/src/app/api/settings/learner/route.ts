import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import {
  readLearnerInstructions,
  resetLearnerInstructions,
  saveLearnerInstructions,
} from '@/lib/learner-preferences';
import { hasValidRequestOrigin } from '@/lib/security';

const MAX_BODY = 16_000;

const saveSchema = z.object({
  instructions: z.string().max(4000),
}).strict();

const resetSchema = z.object({
  action: z.literal('reset'),
}).strict();

export async function GET(request: Request) {
  if (!hasValidRequestOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await readLearnerInstructions(user.id));
  } catch {
    return NextResponse.json({ error: 'Could not read learner instructions' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try { return await handlePost(request); } catch {
    return NextResponse.json({ error: 'Could not update learner instructions. Please try again.' }, { status: 503 });
  }
}

async function handlePost(request: Request) {
  if (!hasValidRequestOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY) {
    return NextResponse.json({ error: 'Learner instructions are too large' }, { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return NextResponse.json({ error: 'Learner instructions are too large' }, { status: 413 });
  }
  const body = parseJson(raw);
  const reset = resetSchema.safeParse(body);
  if (reset.success) {
    return NextResponse.json(await resetLearnerInstructions(user.id));
  }
  const save = saveSchema.safeParse(body);
  if (!save.success) return NextResponse.json({ error: 'Invalid learner instructions' }, { status: 400 });
  const saved = await saveLearnerInstructions(user.id, save.data.instructions);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  return NextResponse.json(saved.record);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
