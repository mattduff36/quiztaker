import { spawn, spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';

export const HELPER_RELEASE_REPOSITORY = 'mattduff36/quiztaker';

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_COMMAND_ARG = /^[A-Za-z0-9 .:_\-\\/@~()[\]]+$/;
const REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export interface HelperUpdateOffer {
  version: string;
  requestedAt: string;
  downloadUrl: string;
  sha256: string;
  installerUrl: string | null;
  installerSha256: string | null;
}

interface UpdateStatus {
  version: string;
  requestedAt: string;
  phase: 'installing' | 'failed';
  startedAt?: string;
  detail?: string;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareNumericVersions(candidate, current) > 0;
}

export function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part) || 0);
  const rightParts = right.split('.').map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function classifyReleaseAsset(url: string, version: string): 'zip' | 'msi' | null {
  if (!RELEASE_VERSION.test(version)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const prefix = `/${HELPER_RELEASE_REPOSITORY}/releases/download/v${version}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  let name = parsed.pathname.slice(prefix.length);
  try {
    name = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (name === `vitriol-helper-windows-x64-v${version}.zip`) return 'zip';
  if (name === `VitriolHelper-${version}-win-x64.msi`) return 'msi';
  return null;
}

export function isAllowedReleaseHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && REDIRECT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function chooseReleaseAsset(offer: HelperUpdateOffer): { url: string; sha256: string; kind: 'zip' | 'msi' } | null {
  if (
    offer.installerUrl
    && offer.installerSha256
    && isSha256(offer.installerSha256)
    && classifyReleaseAsset(offer.installerUrl, offer.version) === 'msi'
  ) {
    return { url: offer.installerUrl, sha256: offer.installerSha256.toLowerCase(), kind: 'msi' };
  }
  if (isSha256(offer.sha256) && classifyReleaseAsset(offer.downloadUrl, offer.version) === 'zip') {
    return { url: offer.downloadUrl, sha256: offer.sha256.toLowerCase(), kind: 'zip' };
  }
  return null;
}

export function shouldAttemptUpdate(status: UpdateStatus | null, offer: HelperUpdateOffer, now = Date.now()): boolean {
  if (!status) return true;
  if (status.phase === 'failed' && status.version === offer.version && status.requestedAt === offer.requestedAt) return false;
  if (status.phase === 'installing' && status.startedAt) {
    const started = Date.parse(status.startedAt);
    if (Number.isFinite(started) && now - started < 10 * 60_000) return false;
  }
  return true;
}

export function createApplyScript(): string {
  return [
    '@echo off',
    'setlocal EnableExtensions',
    'set "PID=%~1"',
    'set "MSI=%~2"',
    'set "LAUNCHER=%~3"',
    'set "CONTROL=%~4"',
    'set "RESULT=%~dp0installer-exit.txt"',
    'set /a TRIES=0',
    ':wait',
    'set /a TRIES+=1',
    'if %TRIES% GTR 30 goto install',
    'tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait',
    ')',
    ':install',
    'ping -n 3 127.0.0.1 >nul',
    '"%SystemRoot%\\System32\\msiexec.exe" /i "%MSI%" /qn /norestart',
    'set "CODE=%ERRORLEVEL%"',
    '>"%RESULT%" echo %CODE%',
    'if exist "%LAUNCHER%" start "" "%LAUNCHER%" --control-plane-url="%CONTROL%"',
    'exit /b 0',
    '',
  ].join('\r\n');
}

export function quoteCommandArg(value: string): string {
  if (!value || !SAFE_COMMAND_ARG.test(value)) throw new Error('The helper update path is not safe to launch.');
  return `"${value}"`;
}

export function installedLauncherPath(localAppData = process.env.LOCALAPPDATA): string | null {
  if (!localAppData) return null;
  return join(localAppData, 'Programs', 'Vitriol Helper', 'Start Vitriol Helper.cmd');
}

export function assertControlPlaneUrl(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  const production = url.protocol === 'https:' && ['vitriol.co.uk', 'www.vitriol.co.uk'].includes(url.hostname);
  if ((!local && !production) || url.username || url.password) {
    throw new Error('The helper update cannot restart against this control plane.');
  }
  return url.origin;
}

export async function reconcileHelperUpdate(helperHome: string, currentVersion: string): Promise<void> {
  const directory = join(helperHome, 'updates');
  const status = await readStatus(directory);
  if (!status) return;
  if (compareNumericVersions(currentVersion, status.version) >= 0) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  const exitPath = join(directory, 'installer-exit.txt');
  if (!existsSync(exitPath)) return;
  const code = (await readFile(exitPath, 'utf8')).trim().replace(/[^\d]/g, '').slice(0, 8);
  await rm(exitPath, { force: true });
  const detail = code === '0' || code === '3010'
    ? 'The installer finished, but the helper version did not change. Download the installer from Operations and run it.'
    : `The helper installer exited with code ${code || 'unknown'}. Download the installer from Operations and run it.`;
  await writeStatus(directory, {
    version: status.version,
    requestedAt: status.requestedAt,
    phase: 'failed',
    detail,
  });
}

export async function helperUpdateError(helperHome: string): Promise<string | undefined> {
  const status = await readStatus(join(helperHome, 'updates'));
  if (status?.phase === 'failed' && status.detail) return status.detail.slice(0, 500);
  return undefined;
}

export async function installHelperUpdate(options: {
  offer: HelperUpdateOffer;
  helperHome: string;
  controlPlaneUrl: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: (commandLine: string) => void;
}): Promise<'restarting' | 'skipped' | 'failed'> {
  const directory = join(options.helperHome, 'updates');
  await mkdir(directory, { recursive: true });
  const status = await readStatus(directory);
  if (!shouldAttemptUpdate(status, options.offer)) return 'skipped';
  try {
    if ((options.platform ?? process.platform) !== 'win32') throw new Error('Helper updates install only on Windows.');
    const controlPlaneUrl = assertControlPlaneUrl(options.controlPlaneUrl);
    const launcher = installedLauncherPath(options.localAppData);
    if (!launcher || !existsSync(launcher)) {
      throw new Error('Vitriol Helper is not installed in the per-user Programs folder, so it cannot replace itself.');
    }
    const asset = chooseReleaseAsset(options.offer);
    if (!asset) throw new Error('The published helper release is not a trusted installer.');
    const msiPath = join(directory, 'helper-update.msi');
    if (asset.kind === 'msi') {
      await downloadVerifiedAsset({
        url: asset.url,
        sha256: asset.sha256,
        destination: msiPath,
        fetchImpl: options.fetchImpl,
      });
    } else {
      const zipPath = join(directory, 'helper-update.zip');
      await downloadVerifiedAsset({
        url: asset.url,
        sha256: asset.sha256,
        destination: zipPath,
        fetchImpl: options.fetchImpl,
      });
      const extracted = await extractMsi(zipPath, join(directory, 'extracted'), options.offer.version);
      await copyFile(extracted, msiPath);
    }
    const scriptPath = join(directory, 'apply-update.cmd');
    await writeFile(scriptPath, createApplyScript(), 'utf8');
    const command = [
      quoteCommandArg(scriptPath),
      quoteCommandArg(String(process.pid)),
      quoteCommandArg(msiPath),
      quoteCommandArg(launcher),
      quoteCommandArg(controlPlaneUrl),
    ].join(' ');
    await writeStatus(directory, {
      version: options.offer.version,
      requestedAt: options.offer.requestedAt,
      phase: 'installing',
      startedAt: new Date().toISOString(),
    });
    (options.spawnImpl ?? defaultSpawn)(`"${command}"`);
    return 'restarting';
  } catch (error) {
    await writeStatus(directory, {
      version: options.offer.version,
      requestedAt: options.offer.requestedAt,
      phase: 'failed',
      detail: updateErrorMessage(error),
    }).catch(() => undefined);
    return 'failed';
  }
}

export async function downloadVerifiedAsset(options: {
  url: string;
  sha256: string;
  destination: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!isSha256(options.sha256)) throw new Error('The published helper checksum is missing.');
  const response = await followReleaseDownload(options.url, options.fetchImpl ?? fetch);
  if (!response.ok || !response.body) throw new Error(`The helper download failed (${response.status}).`);
  await writeLimited(response.body, options.destination, MAX_DOWNLOAD_BYTES);
  const actual = await sha256File(options.destination);
  if (!hashesMatch(actual, options.sha256)) {
    await rm(options.destination, { force: true });
    throw new Error('The helper download did not match the published checksum.');
  }
}

async function followReleaseDownload(url: string, fetchImpl: typeof fetch): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!isAllowedReleaseHost(current)) throw new Error('The helper download host is not trusted.');
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('The helper download redirect was empty.');
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error('The helper download redirect was too long.');
}

async function writeLimited(body: ReadableStream<Uint8Array>, destination: string, maxBytes: number): Promise<void> {
  const reader = body.getReader();
  const file = createWriteStream(destination);
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = Buffer.from(next.value);
      received += bytes.length;
      if (received > maxBytes) throw new Error('The helper download is larger than expected.');
      if (!file.write(bytes)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
    }
    file.end();
    await finished(file);
  } catch (error) {
    file.destroy();
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function extractMsi(zipPath: string, destinationDir: string, version: string): Promise<string> {
  if (!RELEASE_VERSION.test(version)) throw new Error('The published helper release is not a trusted installer.');
  await rm(destinationDir, { recursive: true, force: true });
  await mkdir(destinationDir, { recursive: true });
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath ${quoteCommandArg(zipPath)} -DestinationPath ${quoteCommandArg(destinationDir)} -Force`,
  ], { windowsHide: true });
  if (result.status !== 0) throw new Error('The helper package could not be extracted.');
  const found = await findNamedFile(destinationDir, `VitriolHelper-${version}-win-x64.msi`);
  if (!found) throw new Error('The helper package did not contain the installer.');
  return found;
}

async function findNamedFile(root: string, name: string): Promise<string | null> {
  const matches: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('..')) continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  }
  await walk(root);
  const found = matches[0];
  return matches.length === 1 && found ? found : null;
}

function defaultSpawn(commandLine: string): void {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
}

async function readStatus(directory: string): Promise<UpdateStatus | null> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as Partial<UpdateStatus>;
    if ((value.phase !== 'installing' && value.phase !== 'failed') || typeof value.version !== 'string' || typeof value.requestedAt !== 'string') {
      return null;
    }
    return {
      version: value.version,
      requestedAt: value.requestedAt,
      phase: value.phase,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
      detail: typeof value.detail === 'string' ? value.detail : undefined,
    };
  } catch {
    return null;
  }
}

async function writeStatus(directory: string, status: UpdateStatus): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'status.json');
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(status), 'utf8');
  await rename(temporary, target);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function hashesMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual.toLowerCase());
  const right = Buffer.from(expected.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

function updateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The helper update failed.';
  if (message.length > 300 || /bearer|token|secret|authorization/i.test(message)) return 'The helper update failed.';
  return message;
}
