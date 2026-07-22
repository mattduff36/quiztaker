import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deriveHelperSecret } from '@quiztaker/core';
import { queryOne } from '@/lib/db';
import { getServerEnv } from '@/lib/env';
import { hashPairingCode, normalizePairingCode } from '@/lib/security';

const schema = z.object({
  code: z.string().min(6).max(20),
  deviceName: z.string().min(1).max(200),
  platform: z.literal('win32'),
  architecture: z.enum(['x64', 'arm64']),
  version: z.string().min(1).max(50),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid pairing request' }, { status: 400 });
  try {
    const helper = await queryOne<{ id: string }>(
      `select id from claim_pairing_code($1, $2, $3, $4, $5)`,
      [
        hashPairingCode(normalizePairingCode(parsed.data.code)),
        parsed.data.deviceName,
        parsed.data.platform,
        parsed.data.architecture,
        parsed.data.version,
      ],
    );
    if (!helper) return NextResponse.json({ error: 'Pairing code is invalid or expired' }, { status: 404 });
    return NextResponse.json({
      helperId: helper.id,
      deviceSecret: deriveHelperSecret(getServerEnv().HELPER_MASTER_KEY, helper.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pairing failed';
    const status = /invalid or expired/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
