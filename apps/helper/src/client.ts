import { capabilityManifest, PROTOCOL_VERSION, type JobEnvelope, type JobEventInput } from '@quiztaker/core';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { HelperConfig } from './config.js';
import { unprotectSecret } from './config.js';
import type { HelperUpdateOffer } from './updater.js';
import { HELPER_VERSION } from './version.js';
import { takeOutboxBatch } from './outbox.js';
import type { HelperTerminal } from './terminal-ui.js';
import { sanitizeLogText } from './terminal-ui.js';

interface PollResponse {
  job: JobEnvelope | null;
}

export class ControlPlaneClient {
  private readonly secret: string;

  constructor(private readonly config: HelperConfig, private readonly terminal?: HelperTerminal) {
    this.secret = unprotectSecret(config.encryptedDeviceSecret);
  }

  get deviceSecret(): string {
    return this.secret;
  }

  async remoteExchange(input: import('./remote.js').RemoteExchangeInput): Promise<import('./remote.js').RemoteExchange> {
    const response=await this.request('/api/helper/remote',{method:'POST',body:JSON.stringify(input)},10_000);
    return response.json();
  }

  async heartbeat(state: {
    status: 'online' | 'busy';
    browserChangeToken?:string;
    activeJobId?: string;
    attentionJobId?: string;
    updateError?: string;
    updatePhase?: import('./updater.js').HelperUpdatePhase;
    updateVersion?: string;
  }): Promise<{ update: HelperUpdateOffer | null; taskResolved: string | null }> {
    const response = await this.request('/api/helper/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        status: state.status,
        ...(state.browserChangeToken?{browserChangeToken:state.browserChangeToken}:{}),
        ...(state.activeJobId ? { activeJobId: state.activeJobId } : {}),
        ...(state.attentionJobId ? { attentionJobId: state.attentionJobId } : {}),
        ...(state.updateError ? { updateError: state.updateError } : {}),
        ...(state.updatePhase && state.updateVersion ? { updatePhase: state.updatePhase, updateVersion: state.updateVersion } : {}),
        version: HELPER_VERSION,
        cdpPort: Number(process.env.PLAYWRIGHT_CDP_PORT || 9222),
        protocolVersion: PROTOCOL_VERSION,
        capabilities: capabilityManifest(),
        supportsSelfUpdate: true,
      }),
    });
    const payload = await response.json().catch(() => null) as { update?: unknown; taskResolved?: unknown } | null;
    return { update: readUpdateOffer(payload?.update), taskResolved: typeof payload?.taskResolved === 'string' && payload.taskResolved === state.attentionJobId ? payload.taskResolved : null };
  }

  async poll(): Promise<JobEnvelope | null> {
    const response = await this.request('/api/helper/jobs/next', { method: 'GET' });
    const body = await response.json() as PollResponse;
    return body.job;
  }

  async sendEvent(jobId: string, event: JobEventInput): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.request(`/api/helper/jobs/${encodeURIComponent(jobId)}/events`, {
          method: 'POST',
          body: JSON.stringify(event),
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async proposeLearnerStep(
    jobId: string,
    snapshot: unknown,
  ): Promise<{ action?: unknown; stop?: boolean; error?: string; screenshot?: 'accepted' | 'omitted' | 'unconfirmed' }> {
    const response = await this.request(`/api/helper/jobs/${encodeURIComponent(jobId)}/proposal`, {
      method: 'POST',
      body: JSON.stringify({ snapshot }),
    }, 150_000);
    return response.json();
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    const response = await this.request(`/api/helper/jobs/${encodeURIComponent(jobId)}/status`, {
      method: 'GET',
    });
    const body = await response.json() as { cancelRequested?: boolean };
    return body.cancelRequested === true;
  }

  async syncHistory(payload: {
    history: Array<Record<string, unknown>>;
    reviews?: Array<Record<string, unknown>>;
    captures?: Array<Record<string, unknown>>;
  }): Promise<void> {
    if (!payload.history.length && !payload.reviews?.length && !payload.captures?.length) return;
    await this.request('/api/helper/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getStrategies(): Promise<{ schemaVersion: number; revision: number; strategies: Record<string, unknown> }> {
    const response = await this.request('/api/helper/strategies', { method: 'GET' });
    return response.json() as Promise<{ schemaVersion: number; revision: number; strategies: Record<string, unknown> }>;
  }

  async uploadArtifact(jobId: string, filePath: string): Promise<void> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.set('file', new Blob([bytes]), basename(filePath));
    await this.request(`/api/helper/jobs/${encodeURIComponent(jobId)}/artifacts`, {
      method: 'POST',
      body: form,
    });
  }

  async getLatestRelease(): Promise<{ version: string; downloadUrl: string } | null> {
    const response = await this.request('/api/helper/release', { method: 'GET' });
    const value = await response.json() as {
      release?: { version: string; downloadUrl: string } | null;
    };
    return value.release ?? null;
  }

  private async request(path: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const started = Date.now();
    const method = init.method || 'GET';
    const privateRemote=path==='/api/helper/remote';
    try { if(!privateRemote)this.terminal?.sent(method, path, init.body); } catch { /* Observability must not stop a request. */ }
    try {
    const response = await fetch(`${this.config.controlPlaneUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'X-Helper-Id': this.config.helperId,
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if(!privateRemote)await this.terminal?.received(method, path, response, Date.now() - started).catch(() => undefined);
    if (!response.ok) {
      if(privateRemote)throw new Error('Private browser relay unavailable');
      const detail = await response.text().catch(() => '');
      throw new Error(`Control plane returned ${response.status}: ${sanitizeLogText(detail.slice(0, 4000))}`);
    }
    return response;
    } catch (error) {
      if(!privateRemote)this.terminal?.log('HTTP ERROR', error);
      throw error;
    }
  }
}

/** Stop on the first failed replay; retain it and every unsent event. */
export async function flushPendingEvents(send: (jobId: string, event: JobEventInput) => Promise<void>): Promise<void> {
  const batch = takeOutboxBatch();
  for (const [index, item] of batch.events.entries()) {
    try { await send(item.jobId, item.event); }
    catch { batch.commit(batch.events.slice(index)); return; }
  }
  batch.commit([]);
}

function readUpdateOffer(value: unknown): HelperUpdateOffer | null {
  if (!value || typeof value !== 'object') return null;
  const update = value as Partial<HelperUpdateOffer>;
  if (
    typeof update.version !== 'string'
    || typeof update.requestedAt !== 'string'
    || typeof update.downloadUrl !== 'string'
    || typeof update.sha256 !== 'string'
  ) return null;
  return {
    version: update.version,
    requestedAt: update.requestedAt,
    downloadUrl: update.downloadUrl,
    sha256: update.sha256,
    installerUrl: typeof update.installerUrl === 'string' ? update.installerUrl : null,
    installerSha256: typeof update.installerSha256 === 'string' ? update.installerSha256 : null,
  };
}
