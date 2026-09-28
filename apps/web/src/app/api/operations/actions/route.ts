import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { hasValidRequestOrigin } from '@/lib/security';
import { createCapabilityPlan, endOperatorSession, forgetRecentUrl } from '@/lib/operations';
import { createJob } from '@/lib/jobs';
import { queryOne } from '@/lib/db';

const schema = z.object({
  helperId: z.string().uuid(),
  action: z.enum(['plan', 'forget-url', 'end-session']),
  capabilityId: z.string().optional(),
  capabilityInput: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['auto-detect', 'manual-capability', 'direct-readonly']).optional(),
  label: z.string().max(200).optional(),
  targets: z.array(z.object({ id: z.string().optional(), title: z.string().min(1).max(500) })).max(100).optional(),
  evidence: z.array(z.string().max(1000)).max(50).optional(),
  steps: z.array(z.string()).max(30).optional(),
  fingerprint: z.string().max(200).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  url: z.string().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  forceClose: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  const owned = await queryOne(
    'select id from helpers where id = $1 and user_id = $2 and revoked_at is null',
    [parsed.data.helperId, user.id],
  );
  if (!owned) return NextResponse.json({ error: 'Helper not found' }, { status: 404 });
  try {
    if (parsed.data.action === 'forget-url') {
      if (!parsed.data.url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
      await forgetRecentUrl(user.id, parsed.data.url);
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.action === 'end-session') {
      const result = await endOperatorSession({
        userId: user.id,
        helperId: parsed.data.helperId,
        idempotencyKey: parsed.data.idempotencyKey || crypto.randomUUID(),
        forceClose: parsed.data.forceClose === true,
      });
      return NextResponse.json(result);
    }
    if (!parsed.data.capabilityId) return NextResponse.json({ error: 'Capability is required' }, { status: 400 });
    const plan = await createCapabilityPlan(user.id, {
      helperId: parsed.data.helperId,
      capabilityId: parsed.data.capabilityId,
      capabilityInput: parsed.data.capabilityInput,
      source: parsed.data.source,
      label: parsed.data.label,
      targets: parsed.data.targets,
      evidence: parsed.data.evidence,
      steps: parsed.data.steps,
      fingerprint: parsed.data.fingerprint,
      confidence: parsed.data.confidence,
    });
    if (parsed.data.confirm) {
      await queryOne(
        `update plans set confirmed = true, confirmed_at = now()
         where id = $1 and user_id = $2 and consumed = false`,
        [plan.planId, user.id],
      );
      const job = await createJob(user.id, plan.planId);
      return NextResponse.json({ plan, jobId: job.jobId });
    }
    return NextResponse.json({ plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not perform action';
    const status = /stale|disabled|roster|required|active/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
