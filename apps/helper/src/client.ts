import { capabilityManifest, PROTOCOL_VERSION, type JobEnvelope, type JobEventInput } from '@quiztaker/core';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { HelperConfig } from './config.js';
import { unprotectSecret } from './config.js';
import type { HelperUpdateOffer } from './updater.js';
import { HELPER_VERSION } from './version.js';

interface PollResponse {
  job: JobEnvelope | null;
}

export class ControlPlaneClient {
  private readonly secret: string;

  constructor(private readonly config: HelperConfig) {
    this.secret = unprotectSecret(config.encryptedDeviceSecret);
  }

  get deviceSecret(): string {
    return this.secret;
  }

  async heartbeat(state: {
    status: 'online' | 'busy';
    activeJobId?: string;
    updateError?: string;
  }): Promise<{ update: HelperUpdateOffer | null }> {
    const response = await this.request('/api/helper/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        status: state.status,
        ...(state.activeJobId ? { activeJobId: state.activeJobId } : {}),
        ...(state.updateError ? { updateError: state.updateError } : {}),
        version: HELPER_VERSION,
        cdpPort: Number(process.env.PLAYWRIGHT_CDP_PORT || 9222),
        protocolVersion: PROTOCOL_VERSION,
        capabilities: capabilityManifest(),
        supportsSelfUpdate: true,
      }),
    });
    const payload = await response.json().catch(() => null) as { update?: unknown } | null;
    return { update: readUpdateOffer(payload?.update) };
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
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
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

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.config.controlPlaneUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'X-Helper-Id': this.config.helperId,
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Control plane returned ${response.status}: ${detail}`);
    }
    return response;
  }
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
