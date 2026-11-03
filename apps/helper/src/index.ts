import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROTOCOL_VERSION, classifyOutcome } from '@quiztaker/core';
import { ControlPlaneClient } from './client.js';
import { replayBeforeHeartbeat } from './reporting.js';
import { acquireInstanceLock } from './instance-lock.js';
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
import { readLocalCaptures, readLocalHistory, readLocalReviews } from './sync.js';
import { migrateLegacyLocalData } from './migrate.js';
import { HELPER_VERSION } from './version.js';
import { helperUpdateError, helperUpdateProgress, installHelperUpdate, isNewerVersion, reconcileHelperUpdate, type HelperUpdatePhase } from './updater.js';
import { minimizeHelperWindow, shouldAutoMinimize } from './windows.js';
import { HelperTerminal } from './terminal-ui.js';

let isStopping = false;
let hasAnnouncedOnline = false;
let runningJob: { jobId: string; run: RunningJob } | null = null;
let nextSyncAt = 0;
let nextStrategyPullAt = 0;
let nextReleaseCheckAt = 0;
let hasReportedConnectionRemediation = false;
let terminal: HelperTerminal | null = null;
let restoreConsole: (() => void) | null = null;
let releaseInstance: (() => void) | null = null;

async function main(): Promise<void> {
  ensureHelperDirectories();
  releaseInstance = await acquireInstanceLock(getHelperHome());
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

  terminal = new HelperTerminal({ helperHome: getHelperHome(), version: HELPER_VERSION, device: config.deviceName });
  restoreConsole = terminal.installConsole();
  const client = new ControlPlaneClient(config, terminal);
  console.log(`Vitriol Helper ${HELPER_VERSION} (protocol ${PROTOCOL_VERSION})`);
  console.log(`Device: ${config.deviceName} (${config.helperId})`);
  console.log(`Control plane: ${config.controlPlaneUrl}`);

  while (!isStopping) {
    try {
      await replayBeforeHeartbeat((jobId, event) => client.sendEvent(jobId, event));
      const heartbeat = await client.heartbeat({
        ...(runningJob
          ? { status: 'busy' as const, activeJobId: runningJob.jobId }
          : { status: 'online' as const }),
        updateError: await helperUpdateError(getHelperHome()),
        ...await helperUpdateProgress(getHelperHome()),
      });
      if (heartbeat.update && !runningJob && !isStopping) {
        let phase: HelperUpdatePhase = 'preparing';
        let reporting: Promise<unknown> | null = null;
        const reportPhase = async (next: HelperUpdatePhase) => {
          phase = next;
          terminal?.setStatus({ updatePhase: phase });
          if (reporting) await reporting.catch(() => undefined);
          reporting = client.heartbeat({ status: 'online', updatePhase: phase, updateVersion: heartbeat.update!.version,
            updateError: await helperUpdateError(getHelperHome()) });
          await reporting.catch(() => console.warn('Update progress could not be sent; the helper will retry.'));
          reporting = null;
        };
        const progressTimer = setInterval(() => { if (!reporting) void reportPhase(phase); }, 5_000);
        let outcome: Awaited<ReturnType<typeof installHelperUpdate>>;
        try { outcome = await installHelperUpdate({
          offer: heartbeat.update,
          helperHome: getHelperHome(),
          controlPlaneUrl: config.controlPlaneUrl,
          onPhase: (value) => reportPhase(value),
        }); } finally { clearInterval(progressTimer); }
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
            (event) => client.sendEvent(jobId, event),
            {
              proposeLearnerStep: (snapshot) => client.proposeLearnerStep(jobId, snapshot),
              isCancellationRequested: () => client.isCancellationRequested(jobId),
            },
          );
          runningJob = { jobId, run };
          terminal?.setStatus({ job: `${envelope.payload.capabilityId} ${jobId.slice(0, 8)}` });
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
              terminal?.setStatus({ job: '' });
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
  releaseInstance?.();
}

async function announceOnline(controlPlaneUrl: string): Promise<void> {
  console.log('');
  console.log('Connected and online.');
  console.log(`Open ${controlPlaneUrl} in your browser and continue to Operations.`);
  console.log('Keep this helper running; close its window when you want it to go offline.');
  if (!process.argv.includes('--minimize') || !shouldAutoMinimize()) {
    console.log('The live helper status and traffic remain visible. Use --minimize to minimize after connection.');
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
  terminal?.setStatus({ connection: 'stopping' });
  runningJob?.run.cancel();
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
process.once('exit', () => { restoreConsole?.(); terminal?.close(); });

main().catch((error) => {
  releaseInstance?.();
  console.error(error);
  process.exitCode = 1;
});
