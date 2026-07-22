import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  capabilities,
  verifyJob,
  type JobEnvelope,
  type JobEventInput,
} from '@quiztaker/core';
import { ensureHelperDirectories, getAutomationRoot, getHelperHome } from './config.js';

const MAX_CAPTURED_OUTPUT_CHARS = 10 * 1024 * 1024;

export interface RunningJob {
  child: ChildProcessWithoutNullStreams;
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
  if (hasUsedNonce(envelope.payload.nonce)) throw new Error('Job nonce has already been used.');
  rememberNonce(envelope.payload.nonce);

  const capability = capabilities.find((item) => (
    item.id === envelope.payload.capabilityId &&
    item.version === envelope.payload.capabilityVersion &&
    item.script === envelope.payload.script
  ));
  if (!capability) throw new Error('Job capability is not in the local whitelist.');

  const scriptPath = resolve(getAutomationRoot(), envelope.payload.script);
  if (!existsSync(scriptPath)) throw new Error(`Executor is missing: ${capability.script}`);
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

  const child = spawn(process.env.QUIZTAKER_NODE_PATH || process.execPath, [
    scriptPath,
    ...envelope.payload.args,
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
      const data = isCancelled ? { requestedAt: new Date().toISOString(), code, output } : { code, output };
      void emit(event, data).finally(() => resolvePromise({ code, output }));
    });
  });

  return {
    child,
    completion,
    cancel: () => {
      if (isCancelled || child.exitCode !== null) return;
      isCancelled = true;
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

function nonceFile(): string {
  return join(getHelperHome(), 'used-job-nonces.jsonl');
}

function hasUsedNonce(nonce: string): boolean {
  try {
    return readFileSync(nonceFile(), 'utf8').split('\n').some((line) => line.trim() === nonce);
  } catch {
    return false;
  }
}

function rememberNonce(nonce: string): void {
  ensureHelperDirectories();
  appendFileSync(nonceFile(), `${nonce}\n`);
}
