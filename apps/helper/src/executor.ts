import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  capabilities,
  resolveScriptArgs,
  resultEnvelope,
  verifyJob,
  type JobEnvelope,
  type JobEventInput,
} from '@quiztaker/core';
import { readBrowserSession } from './browser-session.js';
import { closeOwnedBrowser, ensureBrowser, killTree } from './browser-supervisor.js';
import { ensureHelperDirectories, getAutomationRoot, getHelperHome } from './config.js';
import { structuredResult } from './results.js';

const MAX_CAPTURED_OUTPUT_CHARS = 10 * 1024 * 1024;

export interface RunningJob {
  child: ChildProcessWithoutNullStreams | null;
  completion: Promise<{ code: number | null; output: string }>;
  cancel: () => void;
}

export function startJob(
  envelope: JobEnvelope,
  helperId: string,
  deviceSecret: string,
  sendEvent: (event: JobEventInput) => Promise<void>,
): RunningJob {
  if (envelope.payload.helperId !== helperId) throw new Error('Job targets another helper.');
  if (!verifyJob(envelope, deviceSecret)) throw new Error('Job signature or capability is invalid.');
  if (hasCompletedNonce(envelope.payload.nonce, envelope.payload.jobId)) {
    throw new Error('Job nonce has already been used.');
  }
  rememberNonce(envelope.payload.nonce, envelope.payload.jobId, false);

  const capability = capabilities.find((item) => (
    item.id === envelope.payload.capabilityId &&
    item.version === envelope.payload.capabilityVersion &&
    item.script === envelope.payload.script
  ));
  if (!capability) throw new Error('Job capability is not in the local whitelist.');

  const scriptPath = resolve(getAutomationRoot(), envelope.payload.script);
  if (!['start-browser', 'close-browser'].includes(capability.id) && !existsSync(scriptPath)) {
    throw new Error(`Executor is missing: ${capability.script}`);
  }
  ensureHelperDirectories();

  let sequence = 0;
  let output = '';
  let isOutputTruncated = false;
  let isCancelled = false;
  let eventQueue = Promise.resolve();
  const emit = (event: JobEventInput['event'], data: Record<string, unknown>) => {
    sequence += 1;
    const input = { sequence, event, data, occurredAt: new Date().toISOString() };
    eventQueue = eventQueue.catch(() => undefined).then(() => sendEvent(input));
    return eventQueue;
  };

  if (capability.id === 'start-browser' || capability.id === 'close-browser') {
    return runBrowserJob(capability.id, emit, envelope.payload.nonce, envelope.payload.jobId);
  }

  let scriptArgs = envelope.payload.args;
  try {
    scriptArgs = resolveScriptArgs(capability.id, envelope.payload.args, readBrowserSession());
  } catch (error) {
    void emit('failed', { error: error instanceof Error ? error.message : 'Browser target is stale' });
    rememberNonce(envelope.payload.nonce, envelope.payload.jobId, true);
    return {
      child: null,
      completion: Promise.resolve({ code: 1, output: '' }),
      cancel: () => undefined,
    };
  }

  const child = spawn(process.env.QUIZTAKER_NODE_PATH || process.execPath, [
    scriptPath,
    ...scriptArgs,
  ], {
    cwd: getAutomationRoot(),
    windowsHide: false,
    env: {
      ...process.env,
      QUIZTAKER_HOME: getHelperHome(),
      CDP_PROFILE_DIR: join(getHelperHome(), 'chrome-profile'),
      SABA_ATTEMPT_DIR: join(getHelperHome(), 'data', 'attempts'),
      SABA_KNOWLEDGE_DIR: join(getHelperHome(), 'data', 'knowledge'),
      SABA_ATTEMPT_ID: envelope.payload.attemptId,
      SABA_CAPABILITY_ID: envelope.payload.capabilityId,
      SABA_CAPABILITY_VERSION: String(envelope.payload.capabilityVersion),
      SABA_FINGERPRINT: envelope.payload.fingerprint || '',
    },
  });

  void emit('accepted', { script: capability.script, args: envelope.payload.args });
  void emit('started', { pid: child.pid });
  const completion = new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    child.stdout.on('data', (value: Buffer) => {
      const text = value.toString();
      ({ output, isOutputTruncated } = appendOutput(output, text, isOutputTruncated));
      void emit('stdout', { text });
    });
    child.stderr.on('data', (value: Buffer) => {
      const text = value.toString();
      ({ output, isOutputTruncated } = appendOutput(output, text, isOutputTruncated));
      void emit('stderr', { text });
    });
    child.on('error', (error) => {
      void emit('failed', { error: error.message });
      reject(error);
    });
    child.on('close', (code) => {
      const event = isCancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      const result = structuredResult(capability.id, output, code);
      const data = isCancelled
        ? { requestedAt: new Date().toISOString(), code, output, result }
        : { code, output, result };
      rememberNonce(envelope.payload.nonce, envelope.payload.jobId, true);
      void emit(event, data).finally(() => resolvePromise({ code, output }));
    });
  });

  return {
    child,
    completion,
    cancel: () => {
      if (isCancelled || child.exitCode !== null) return;
      isCancelled = true;
      if (child.pid) killTree(child.pid);
      child.kill();
    },
  };
}

function appendOutput(output: string, text: string, isTruncated: boolean) {
  if (isTruncated) return { output, isOutputTruncated: true };
  const remaining = MAX_CAPTURED_OUTPUT_CHARS - output.length;
  if (text.length <= remaining) return { output: output + text, isOutputTruncated: false };
  return {
    output: `${output}${text.slice(0, Math.max(0, remaining))}\n[output truncated]\n`,
    isOutputTruncated: true,
  };
}

function runBrowserJob(
  capabilityId: string,
  emit: (event: JobEventInput['event'], data: Record<string, unknown>) => Promise<void>,
  nonce: string,
  jobId: string,
): RunningJob {
  const completion = (async () => {
    await emit('accepted', { script: capabilityId === 'start-browser' ? 'start-cdp-browser.js' : 'pw-close-browser.js', args: [] });
    const value = capabilityId === 'start-browser' ? await ensureBrowser() : await closeOwnedBrowser();
    const code = ('connected' in value ? value.connected : value.closed) ? 0 : 1;
    const output = JSON.stringify(value);
    const session = readBrowserSession();
    const result = resultEnvelope(capabilityId, code === 0, {
      ...value,
      ...(session ? { browserSession: { ...session, cdpConnected: capabilityId === 'start-browser' && code === 0 } } : {}),
    });
    rememberNonce(nonce, jobId, true);
    await emit(code === 0 ? 'completed' : 'failed', { code, output, result });
    return { code, output };
  })();
  return { child: null, completion, cancel: () => undefined };
}

function nonceFile(): string {
  return join(getHelperHome(), 'used-job-nonces.jsonl');
}

function hasCompletedNonce(nonce: string, jobId: string): boolean {
  return readNonces().some((item) => item.nonce === nonce && (item.jobId !== jobId || item.terminal));
}

function rememberNonce(nonce: string, jobId: string, terminal: boolean): void {
  ensureHelperDirectories();
  const entries = readNonces().filter((item) => item.nonce !== nonce);
  entries.push({ nonce, jobId, terminal });
  writeNonceFile(entries);
}

function readNonces(): Array<{ nonce: string; jobId: string; terminal: boolean }> {
  try {
    return readFileSync(nonceFile(), 'utf8').split('\n').filter(Boolean).map((line) => {
      if (line.startsWith('{')) return JSON.parse(line) as { nonce: string; jobId: string; terminal: boolean };
      return { nonce: line.trim(), jobId: '', terminal: true };
    });
  } catch {
    return [];
  }
}

function writeNonceFile(entries: Array<{ nonce: string; jobId: string; terminal: boolean }>): void {
  writeFileSync(nonceFile(), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
}
