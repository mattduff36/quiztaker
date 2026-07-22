import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { classifyOutcome } from '@quiztaker/core';
import { ControlPlaneClient } from './client.js';
import { ensureHelperDirectories, getAutomationRoot, readConfig } from './config.js';
import { startJob, type RunningJob } from './executor.js';
import { pairInteractively } from './pairing.js';
import { readLocalHistory } from './sync.js';
import { migrateLegacyLocalData } from './migrate.js';
import { HELPER_VERSION } from './version.js';

let isStopping = false;
let runningJob: { jobId: string; run: RunningJob } | null = null;
let nextSyncAt = 0;
let nextReleaseCheckAt = 0;

async function main(): Promise<void> {
  ensureHelperDirectories();
  const importArg = process.argv.find((value) => value.startsWith('--import-data='));
  migrateLegacyLocalData(importArg?.slice('--import-data='.length));
  const shouldPair = process.argv.includes('--pair');
  const config = shouldPair || !readConfig() ? await pairInteractively() : readConfig();
  if (!config) throw new Error('Helper configuration is missing. Run with --pair.');

  const client = new ControlPlaneClient(config);
  console.log(`Vitriol Helper ${HELPER_VERSION}`);
  console.log(`Device: ${config.deviceName} (${config.helperId})`);
  console.log(`Control plane: ${config.controlPlaneUrl}`);

  while (!isStopping) {
    try {
      await client.heartbeat(runningJob
        ? { status: 'busy', activeJobId: runningJob.jobId }
        : { status: 'online' });
      if (Date.now() >= nextSyncAt) {
        await client.syncHistory(readLocalHistory());
        nextSyncAt = Date.now() + 5 * 60_000;
      }
      if (Date.now() >= nextReleaseCheckAt) {
        const release = await client.getLatestRelease();
        const currentVersion = HELPER_VERSION;
        if (release && isNewerVersion(release.version, currentVersion)) {
          console.log(`Helper update available: v${release.version}`);
          console.log(release.downloadUrl);
        }
        nextReleaseCheckAt = Date.now() + 6 * 60 * 60_000;
      }

      if (!runningJob) {
        const envelope = await client.poll();
        if (envelope) {
          const jobId = envelope.payload.jobId;
          const run = startJob(
            envelope,
            config.helperId,
            client.deviceSecret,
            (event) => client.sendEvent(jobId, event),
          );
          runningJob = { jobId, run };
          void monitorCancellation(client, jobId, run);
          void run.completion
            .then(async ({ code, output }) => {
              const outcome = classifyOutcome({ script: envelope.payload.script, code, output });
              for (const artifact of outcome.artifacts ?? []) {
                const file = isAbsolute(artifact) ? artifact : resolve(getAutomationRoot(), artifact);
                if (existsSync(file)) await client.uploadArtifact(jobId, file);
              }
            })
            .catch((error: unknown) => console.error('Job failed:', error))
            .finally(() => {
              runningJob = null;
            });
        }
      }
      await delay(runningJob ? 2_000 : 5_000);
    } catch (error) {
      console.error(new Date().toISOString(), error instanceof Error ? error.message : error);
      await delay(10_000);
    }
  }
}

async function monitorCancellation(
  client: ControlPlaneClient,
  jobId: string,
  run: RunningJob,
): Promise<void> {
  while (!isStopping && runningJob?.jobId === jobId) {
    await delay(3_000);
    try {
      if (await client.isCancellationRequested(jobId)) {
        run.cancel();
        return;
      }
    } catch {}
  }
}

function stop(): void {
  isStopping = true;
  runningJob?.run.cancel();
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
