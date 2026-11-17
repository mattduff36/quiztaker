import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { ensureHelperDirectories, getAutomationRoot, getHelperHome } from './config.js';
import { rotateBrowserSession } from './browser-session.js';

interface SupervisorState {
  pid?: number;
  port: number;
}

export async function ensureBrowser(): Promise<{ connected: boolean; pid?: number }> {
  if (await cdpReady()) return { connected: true, pid: readState().pid };
  ensureHelperDirectories();
  const script = resolve(getAutomationRoot(), 'start-cdp-browser.js');
  const child = spawn(process.env.QUIZTAKER_NODE_PATH || process.execPath, [script], {
    cwd: getAutomationRoot(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      QUIZTAKER_HOME: getHelperHome(),
      CDP_PROFILE_DIR: join(getHelperHome(), 'chrome-profile'),
    },
  });
  child.unref();
  writeState({ pid: child.pid, port: cdpPort() });
  rotateBrowserSession();
  const connected = await waitForCdpState(true);
  return { connected, pid: child.pid };
}

export async function closeOwnedBrowser(): Promise<{ closed: boolean }> {
  const state = readState();
  // Give Chrome time to save the profile and exit before stopping its launcher.
  await runCloseScript();
  let closed = await waitForCdpState(false, 10);
  if (!closed && state.pid && state.port === cdpPort()) {
    killTree(state.pid);
    closed = await waitForCdpState(false, 10);
  }
  if (closed) {
    writeState({ port: cdpPort() });
    rotateBrowserSession();
  }
  return { closed };
}

export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // The process has already exited.
  }
}

async function runCloseScript(): Promise<void> {
  const script = resolve(getAutomationRoot(), 'pw-close-browser.js');
  await new Promise<void>((resolvePromise) => {
    const child = spawn(process.env.QUIZTAKER_NODE_PATH || process.execPath, [script], {
      cwd: getAutomationRoot(),
      windowsHide: true,
      env: { ...process.env, PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${cdpPort()}` },
    });
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      resolvePromise();
    }, 8_000);
    const finish = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once('close', finish);
    child.once('error', finish);
  });
}

async function waitForCdpState(connected: boolean, attempts = 20): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (connected ? await cdpReady() : !(await browserPortOpen())) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

function browserPortOpen(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port: cdpPort() });
    const finish = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

export function cdpReady(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const request = fetch(`http://127.0.0.1:${cdpPort()}/json/version`, { signal: AbortSignal.timeout(1500) })
      .then((response) => resolvePromise(response.ok))
      .catch(() => resolvePromise(false));
    void request;
  });
}

function cdpPort(): number {
  return Number(process.env.PLAYWRIGHT_CDP_PORT || 9222);
}

function statePath(): string {
  return join(getHelperHome(), 'browser-supervisor.json');
}

function readState(): SupervisorState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as SupervisorState;
  } catch {
    return { port: cdpPort() };
  }
}

function writeState(state: SupervisorState): void {
  ensureHelperDirectories();
  writeFileSync(statePath(), JSON.stringify(state));
}
