import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROTOCOL_VERSION, classifyOutcome, getCapability, type LearnerSnapshot } from '@quiztaker/core';
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
import { askCoordinator, coordinateDecision } from './coordination.js';
import { restoreHelperWindowPlacement } from './window-placement.js';

let isStopping = false;
let hasAnnouncedOnline = false;
let runningJob: { jobId: string; run: RunningJob; cancelRequested: boolean } | null = null;
let attentionJobId: string | null = null;
let windowPlacementRestored = false;
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
  windowPlacementRestored = restoreHelperWindowPlacement(getHelperHome());
  await reconcileHelperUpdate(getHelperHome(), HELPER_VERSION);
  const args = process.argv.slice(2);
  const launch = resolveHelperLaunch(args);
  const legacyMigration = migrateLegacyConfig();
  const importArg = process.argv.find((value) => value.startsWith('--import-data='));
  migrateLegacyLocalData(importArg?.slice('--import-data='.length));
  const savedConfig = readConfig(launch.controlPlaneUrl);
  const shouldPair = args.includes('--pair') || Boolean(launch.pairing);
  const config = shouldPair || !savedConfig ? await pairInteractively(args) : savedConfig;

  terminal = new HelperTerminal({ helperHome: getHelperHome(), version: HELPER_VERSION });
  restoreConsole = terminal.installConsole();
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

  const client = new ControlPlaneClient(config, terminal);
  console.log(`Vitriol Helper ${HELPER_VERSION} (protocol ${PROTOCOL_VERSION})`);
  console.log(`Device: ${config.deviceName} (${config.helperId})`);
  console.log(`Control plane: ${config.controlPlaneUrl}`);

  while (!isStopping) {
    try {
      await replayBeforeHeartbeat((jobId, event) => client.sendEvent(jobId, event));
      const heartbeat = await client.heartbeat({
        ...(attentionJobId ? {attentionJobId} : {}),
        ...(runningJob
          ? { status: 'busy' as const, activeJobId: runningJob.jobId }
          : { status: 'online' as const }),
        updateError: await helperUpdateError(getHelperHome()),
        ...await helperUpdateProgress(getHelperHome()),
      });
      if (!isStopping) terminal.setConnection('online');
      if (!runningJob && heartbeat.taskResolved && heartbeat.taskResolved === attentionJobId) {
        attentionJobId = null;
        terminal.activity('Ready · Task finished.', 'ready');
      }
      if (heartbeat.update && !runningJob && !isStopping) {
        let phase: HelperUpdatePhase | null = null;
        const updateLines: Record<HelperUpdatePhase, string> = {
          preparing: 'Preparing the helper update…',
          downloading: 'Downloading the helper update…',
          installing: 'Installing the helper update…',
          failed: 'Helper update failed. See Operations.',
        };
        let reporting: Promise<unknown> | null = null;
        const reportPhase = async (next: HelperUpdatePhase) => {
          if (phase !== next) terminal?.activity(updateLines[next], next === 'failed' ? 'warning' : 'info');
          phase = next;
          if (reporting) await reporting.catch(() => undefined);
          reporting = client.heartbeat({ status: 'online', updatePhase: phase, updateVersion: heartbeat.update!.version,
            updateError: await helperUpdateError(getHelperHome()) });
          await reporting.catch(() => console.warn('Update progress could not be sent; the helper will retry.'));
          reporting = null;
        };
        const progressTimer = setInterval(() => { if (phase && !reporting) void reportPhase(phase); }, 5_000);
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
        await minimizeAfterConnection();
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
          terminal.activity(`Helper update available · v${release.version}`);
        }
        nextReleaseCheckAt = Date.now() + 6 * 60 * 60_000;
      }

      if (!runningJob) {
        const envelope = await client.poll();
        if (envelope) {
          const jobId = envelope.payload.jobId;
          const capability = envelope.payload.capabilityId;
          const coordinated = capability === 'quiz-learn' && envelope.payload.input?.mode === 'quiz' && envelope.payload.input.intent === 'coordinate';
          const propose = async (snapshot: unknown) => {
            const decision = await client.proposeLearnerStep(jobId, snapshot);
            if (decision.screenshot === 'accepted') terminal?.activity('Screenshot received by the assistant.');
            if (decision.screenshot === 'omitted') terminal?.activity('Screenshot omitted · the assistant connection does not accept images.', 'warning');
            if (decision.screenshot === 'unconfirmed') terminal?.activity('The assistant did not confirm the screenshot request.', 'warning');
            return decision;
          };
          // Automatic tab refreshes are routine housekeeping.
          const action = capability === 'list-tabs' ? null
            : capability === 'start-browser' ? 'Start course browser'
              : capability === 'close-browser' ? 'Close course browser'
                : capability === 'quiz-learn' ? 'Work on course'
                  : getCapability(capability)?.label ?? 'Course task';
          const run = startJob(
            envelope,
            config.helperId,
            client.deviceSecret,
            (event) => client.sendEvent(jobId, event),
            {
              onProgress: (message) => terminal?.activity(message),
              proposeLearnerStep: (snapshot) => coordinated
                ? coordinateDecision(
                    propose,
                    (view, reason) => askCoordinator(getHelperHome(), jobId, view, reason, 70_000,
                      () => isStopping || runningJob?.jobId !== jobId || runningJob.cancelRequested,
                      line => terminal?.activity(line)),
                    snapshot as LearnerSnapshot,
                  )
                : propose(snapshot),
              isCancellationRequested: () => client.isCancellationRequested(jobId),
            },
          );
          const activeJob = { jobId, run, cancelRequested: false };
          runningJob = activeJob;
          if (action) terminal.activity(`Working · ${action}`);
          void monitorCancellation(client, activeJob);
          void run.completion
            .then(async ({ code, output }) => {
              const outcome = classifyOutcome({ script: envelope.payload.script, code, output });
              for (const artifact of outcome.artifacts ?? []) {
                const file = isAbsolute(artifact) ? artifact : resolve(getAutomationRoot(), artifact);
                if (existsSync(file) && isAllowedArtifact(file)) await client.uploadArtifact(jobId, file);
              }
              if (!action || isStopping) return;
              if (capability === 'quiz-learn' || capability === 'class-batch' || capability === 'cert-batch') attentionJobId = outcome.outcome === 'success' ? null : jobId;
              if (outcome.status === 'needs-user-input') terminal?.activity('Waiting for your input in Operations.', 'warning');
              else if (outcome.outcome === 'success') terminal?.activity(`Ready · Finished ${action}`, 'ready');
              else if (outcome.outcome === 'cancelled' || activeJob.cancelRequested) terminal?.activity(`Stopped · ${action}`);
              else terminal?.activity(`Needs attention · ${action}. See Operations.`, 'warning');
            })
            .catch((error: unknown) => {
              console.error('Job failed:', error);
              if (action) attentionJobId = jobId;
              if (action && !isStopping) terminal?.activity(`Needs attention · ${action}. See Operations.`, 'warning');
            })
            .finally(() => {
              runningJob = null;
            });
        }
      }
      await delay(runningJob ? 2_000 : 5_000);
    } catch (error) {
      if (!isStopping) terminal.setConnection('reconnecting');
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        new Date().toISOString(),
        `${describeControlPlane(config.controlPlaneUrl)}: ${message}`,
      );
      if (/Control plane returned 401/.test(message)) {
        terminal.activity('Pairing expired. Open Local helper in Vitriol to reconnect.', 'warning');
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

async function minimizeAfterConnection(): Promise<void> {
  if (windowPlacementRestored) return;
  if (!process.argv.includes('--minimize') || !shouldAutoMinimize()) return;
  await delay(3_000);
  if (!minimizeHelperWindow()) terminal?.activity('Automatic minimize unavailable.', 'warning');
}

async function monitorCancellation(
  client: ControlPlaneClient,
  job: NonNullable<typeof runningJob>,
): Promise<void> {
  while (!isStopping && runningJob === job) {
    await delay(3_000);
    if (isStopping || runningJob !== job) return;
    try {
      if (await client.isCancellationRequested(job.jobId) && runningJob === job) {
        job.cancelRequested = true;
        job.run.cancel();
        return;
      }
    } catch {}
  }
}

function stop(): void {
  isStopping = true;
  terminal?.setConnection('stopping');
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
  if (terminal) {
    console.error(error);
    terminal.activity('Helper stopped unexpectedly. See the diagnostic log.', 'warning');
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
