import type { JobEventInput } from '@quiztaker/core';
import { flushPendingEvents } from './client.js';
import { readOutbox } from './outbox.js';

/** Deliver retained completion evidence before an idle heartbeat can recover its job. */
export async function replayBeforeHeartbeat(send: (jobId: string, event: JobEventInput) => Promise<void>): Promise<void> {
  await flushPendingEvents(send);
  if (readOutbox().length) throw new Error('Job reporting is still pending. Retrying before announcing the helper idle.');
}
