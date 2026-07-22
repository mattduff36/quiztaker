import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HelperConfig {
  schemaVersion: 1;
  controlPlaneUrl: string;
  helperId: string;
  encryptedDeviceSecret: string;
  deviceName: string;
  pairedAt: string;
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const loadDpapiAssembly = 'Add-Type -AssemblyName System.Security';

export function getHelperHome(): string {
  return process.env.QUIZTAKER_HOME || join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'QuizTaker Helper',
  );
}

export function getAutomationRoot(): string {
  return process.env.QUIZTAKER_AUTOMATION_ROOT || resolve(sourceDirectory, '..', '..', '..');
}

export function getConfigPath(): string {
  return join(getHelperHome(), 'config.json');
}

export function ensureHelperDirectories(): void {
  for (const directory of [
    getHelperHome(),
    join(getHelperHome(), 'data'),
    join(getHelperHome(), 'logs'),
    join(getHelperHome(), 'chrome-profile'),
  ]) mkdirSync(directory, { recursive: true });
}

export function readConfig(): HelperConfig | null {
  if (!existsSync(getConfigPath())) return null;
  try {
    return JSON.parse(readFileSync(getConfigPath(), 'utf8')) as HelperConfig;
  } catch {
    return null;
  }
}

export function writeConfig(config: HelperConfig): void {
  ensureHelperDirectories();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function protectSecret(secret: string): string {
  if (process.platform !== 'win32') return `plain:${Buffer.from(secret).toString('base64')}`;
  const script = [
    loadDpapiAssembly,
    '$value = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($value)',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($protected)',
  ].join(';');
  return `dpapi:${execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: secret,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()}`;
}

export function unprotectSecret(value: string): string {
  if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
  if (!value.startsWith('dpapi:') || process.platform !== 'win32') {
    throw new Error('The helper credential cannot be decrypted on this platform.');
  }
  const script = [
    loadDpapiAssembly,
    '$value = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($value)',
    '$clear = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Text.Encoding]::UTF8.GetString($clear)',
  ].join(';');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.slice(6),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
