import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HISTORY_SYNC_LIMITS } from '@quiztaker/core';

export const helperSyncSchema = z.object({
  history: z.array(z.object({
    sourceId: z.string().min(1).max(500),
    kind: z.string().min(1).max(50),
    title: z.string().min(1).max(1000),
    result: z.string().max(500),
    detail: z.string().max(3000).default(''),
    occurredAt: z.string().datetime(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })).max(HISTORY_SYNC_LIMITS.history).default([]),
  reviews: z.array(z.object({
    sourceId: z.string().min(1).max(200),
    type: z.string().min(1).max(80),
    title: z.string().min(1).max(500),
    detail: z.string().max(3000).default(''),
    nextAction: z.string().max(1000).default(''),
  })).max(HISTORY_SYNC_LIMITS.reviews).default([]),
  captures: z.array(z.object({
    sourceId: z.string().min(1).max(200),
    fingerprint: z.string().max(200).nullable().optional(),
    title: z.string().min(1).max(500),
    detail: z.string().max(3000).default(''),
    capturedAt: z.string().datetime(),
    probe: z.record(z.string(), z.unknown()).default({}),
  })).max(HISTORY_SYNC_LIMITS.captures).default([]),
  cursor: z.string().max(200).optional(),
});

// Replays cannot recreate a resolved imported review, including a partial
// request accepted by the server before the helper lost its response.
export function importedReviewId(userId: string, helperId: string, sourceId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([userId, helperId, sourceId])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
