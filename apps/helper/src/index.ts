import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROTOCOL_VERSION, classifyOutcome } from '@quiztaker/core';
import { ControlPlaneClient } from './client.js';
import {
  ensureHelperDirectories,
  getAutomationRoot,
  getHelperHome,
  migrateLegacyConfig,
  readConfig,
} from './config.js';
import { startJob, type RunningJob } from './executor.js';
import {
  describeControlPlane,
  pairInteractively,
  resolveHelperLaunch,
} from './pairing.js';
import { isAllowedArtifact } from './artifacts.js';
import { rememberOutbox, takeOutboxBatch } from './outbox.js';
import { readLocalCaptures, readLocalHistory, readLocalReviews } from './sync.js';
import { migrateLegacyLocalData } from './migrate.js';
import { HELPER_VERSION } from './version.js';
import { helperUpdateError, installHelperUpdate, isNewerVersion, reconcileHelperUpdate } from './updater.js';
import { minimizeHelperWindow, shouldAutoMinimize } from './windows.js';

let isStopping = false;
let hasAnnouncedOnline = false;
let runningJob: { jobId: string; run: RunningJob } | null = null;
let nextSyncAt = 0;
let nextStrategyPullAt = 0;
let nextReleaseCheckAt = 0;
let hasReportedConnectionRemediation = false;

async function main(): Promise<void> {
  ensureHelperDirectories();
  await reconcileHelperUpdate(getHelperHome(), HELPER_VERSION);
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
  console.log(`Vitriol Helper ${HELPER_VERSION} (protocol ${PROTOCOL_VERSION})`);
  console.log(`Device: ${config.deviceName} (${config.helperId})`);
  console.log(`Control plane: ${config.controlPlaneUrl}`);

  while (!isStopping) {
    try {
      const heartbeat = await client.heartbeat({
        ...(runningJob
          ? { status: 'busy' as const, activeJobId: runningJob.jobId }
          : { status: 'online' as const }),
        updateError: await helperUpdateError(getHelperHome()),
      });
      if (heartbeat.update && !runningJob && !isStopping) {
        const outcome = await installHelperUpdate({
          offer: heartbeat.update,
          helperHome: getHelperHome(),
          controlPlaneUrl: config.controlPlaneUrl,
        });
        if (outcome === 'restarting') {
          console.log(`Installing Vitriol Helper ${heartbeat.update.version}. This window will close and reopen.`);
          await delay(1_000);
          process.exit(0);
        }
        if (outcome === 'failed') {
          console.error(await helperUpdateError(getHelperHome()) || 'The helper update failed.');
        }
      }
      if (!hasAnnouncedOnline) {
        hasAnnouncedOnline = true;
        await announceOnline(config.controlPlaneUrl);
      }
      await flushOutbox(client);
      if (Date.now() >= nextSyncAt) {
        await client.syncHistory({
          history: readLocalHistory(),
          reviews: readLocalReviews(),
          captures: readLocalCaptures(),
        });
        nextSyncAt = Date.now() + 5 * 60_000;
      }
      if (Date.now() >= nextStrategyPullAt) {
        try {
          await writeStrategySnapshot(await client.getStrategies());
        } catch (error) {
          console.error('Strategy snapshot was not updated:', error instanceof Error ? error.message : error);
        }
        nextStrategyPullAt = Date.now() + 60_000;
      }
      if (Date.now() >= nextReleaseCheckAt) {
        const release = await client.getLatestRelease();
        const currentVersion = HELPER_VERSION;
        if (release && isNewerVersion(release.version, currentVersion)) {
          console.log(`Helper update available: v${release.version}`);
          console.log('Choose Update helper on the Operations page, or download:');
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
            (event) => client.sendEvent(jobId, event).catch((error: unknown) => {
              rememberOutbox(jobId, event);
              throw error;
            }),
          );
          runningJob = { jobId, run };
          void monitorCancellation(client, jobId, run);
          void run.completion
            .then(async ({ code, output }) => {
              const outcome = classifyOutcome({ script: envelope.payload.script, code, output });
              for (const artifact of outcome.artifacts ?? []) {
                const file = isAbsolute(artifact) ? artifact : resolve(getAutomationRoot(), artifact);
                if (existsSync(file) && isAllowedArtifact(file)) await client.uploadArtifact(jobId, file);
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

async function flushOutbox(client: ControlPlaneClient): Promise<void> {
  const batch = takeOutboxBatch();
  if (!batch.events.length) {
    batch.commit([]);
    return;
  }
  const failed = [];
  for (const item of batch.events) {
    try {
      await client.sendEvent(item.jobId, item.event);
    } catch {
      failed.push(item);
    }
  }
  batch.commit(failed);
}

async function writeStrategySnapshot(snapshot: {
  schemaVersion: number;
  revision: number;
  strategies: Record<string, unknown>;
}): Promise<void> {
  ensureHelperDirectories();
  mkdirSync(join(getHelperHome(), 'data', 'knowledge'), { recursive: true });
  writeFileSync(
    join(getHelperHome(), 'data', 'knowledge', 'strategies.json'),
    JSON.stringify({ schemaVersion: snapshot.schemaVersion, revision: snapshot.revision, strategies: snapshot.strategies }, null, 2),
  );
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
