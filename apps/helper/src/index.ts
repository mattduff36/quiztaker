import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { classifyOutcome } from '@quiztaker/core';
import { ControlPlaneClient } from './client.js';
import {
  ensureHelperDirectories,
  getAutomationRoot,
  migrateLegacyConfig,
  readConfig,
} from './config.js';
import { startJob, type RunningJob } from './executor.js';
import {
  describeControlPlane,
  pairInteractively,
  resolveHelperLaunch,
} from './pairing.js';
import { readLocalHistory } from './sync.js';
import { migrateLegacyLocalData } from './migrate.js';
import { HELPER_VERSION } from './version.js';
import { minimizeHelperWindow, shouldAutoMinimize } from './windows.js';

let isStopping = false;
let hasAnnouncedOnline = false;
let runningJob: { jobId: string; run: RunningJob } | null = null;
let nextSyncAt = 0;
let nextReleaseCheckAt = 0;
let hasReportedConnectionRemediation = false;

async function main(): Promise<void> {
  ensureHelperDirectories();
  const args = process.argv.slice(2);
  const launch = resolveHelperLaunch(args);
  const legacyMigration = migrateLegacyConfig();
  const importArg = process.argv.find((value) => value.startsWith('--import-data='));
  migrateLegacyLocalData(importArg?.slice('--import-data='.length));
  console.log(`Launch target: ${describeControlPlane(launch.controlPlaneUrl)}`);
  if (
    legacyMigration.controlPlaneUrl
    && legacyMigration.controlPlaneUrl !== launch.controlPlaneUrl
  ) {
    console.log(
      `Preserved the previous pairing for ${describeControlPlane(legacyMigration.controlPlaneUrl)}. `
      + 'It will not be used for this launch.',
    );
  }

  const savedConfig = readConfig(launch.controlPlaneUrl);
  const shouldPair = args.includes('--pair') || Boolean(launch.pairing);
  const config = shouldPair || !savedConfig ? await pairInteractively(args) : savedConfig;

  const client = new ControlPlaneClient(config);
  console.log(`Vitriol Helper ${HELPER_VERSION}`);
  console.log(`Device: ${config.deviceName} (${config.helperId})`);
  console.log(`Control plane: ${config.controlPlaneUrl}`);

  while (!isStopping) {
    try {
      await client.heartbeat(runningJob
        ? { status: 'busy', activeJobId: runningJob.jobId }
        : { status: 'online' });
      if (!hasAnnouncedOnline) {
        hasAnnouncedOnline = true;
        await announceOnline(config.controlPlaneUrl);
      }
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        new Date().toISOString(),
        `${describeControlPlane(config.controlPlaneUrl)}: ${message}`,
      );
      if (/Control plane returned 401/.test(message)) {
        console.error(
          `This pairing is not authorized for ${config.controlPlaneUrl}. `
          + `Open ${config.controlPlaneUrl}/helper, generate a new code, and click "Launch Vitriol Helper".`,
        );
        process.exitCode = 1;
        break;
      }
      if (!hasReportedConnectionRemediation && /fetch failed|timeout/i.test(message)) {
        hasReportedConnectionRemediation = true;
        console.error(
          launch.mode === 'local-development'
            ? `The local control plane is unavailable. Start it at ${config.controlPlaneUrl}, `
              + 'or close this helper and use the Start-menu shortcut for production.'
            : `Could not reach ${config.controlPlaneUrl}. Check the network connection; `
              + `if pairing is required, open ${config.controlPlaneUrl}/helper.`,
        );
      }
      await delay(10_000);
    }
  }
}

async function announceOnline(controlPlaneUrl: string): Promise<void> {
  console.log('');
  console.log('Connected and online.');
  console.log(`Open ${controlPlaneUrl} in your browser and continue to Operations.`);
  console.log('Keep this helper running; close its window when you want it to go offline.');
  if (!shouldAutoMinimize()) {
    console.log('Automatic minimize is disabled for this run.');
    return;
  }
  console.log('This window will minimize in 3 seconds.');
  await delay(3_000);
  if (!minimizeHelperWindow()) console.log('Automatic minimize was unavailable; you can minimize this window manually.');
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
