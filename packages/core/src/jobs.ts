import { createHmac, timingSafeEqual } from 'node:crypto';
import { getCapabilityForRun } from './capabilities.js';
import type { JobEnvelope, SignedJobPayload } from './types.js';

export function signJob(payload: SignedJobPayload, secret: string): JobEnvelope {
  return {
    payload,
    signature: createSignature(payload, secret),
  };
}

export function verifyJob(envelope: JobEnvelope, secret: string, now = new Date()): boolean {
  if (Date.parse(envelope.payload.expiresAt) <= now.getTime()) return false;
  const capability = getCapabilityForRun(envelope.payload.script, envelope.payload.args);
  if (
    !capability ||
    capability.id !== envelope.payload.capabilityId ||
    capability.version !== envelope.payload.capabilityVersion
  ) return false;

  const expected = Buffer.from(createSignature(envelope.payload, secret), 'hex');
  const received = Buffer.from(envelope.signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function deriveHelperSecret(masterKey: string, helperId: string): string {
  return createHmac('sha256', masterKey).update(`helper:${helperId}`).digest('base64url');
}

function createSignature(payload: SignedJobPayload, secret: string): string {
  return createHmac('sha256', secret).update(stableJson(payload)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}
