import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
export const PRODUCTION_CONTROL_PLANE_URL = 'https://www.vitriol.co.uk';

export interface LegacyConfigMigration {
  status: 'missing' | 'invalid' | 'already-migrated' | 'migrated';
  controlPlaneUrl?: string;
  configPath?: string;
}

export function getHelperHome(): string {
  return process.env.QUIZTAKER_HOME || join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'QuizTaker Helper',
  );
}

export function getAutomationRoot(): string {
  return process.env.QUIZTAKER_AUTOMATION_ROOT || resolve(sourceDirectory, '..', '..', '..');
}

export function getConfigPath(
  controlPlaneUrl = PRODUCTION_CONTROL_PLANE_URL,
  helperHome = getHelperHome(),
): string {
  return join(helperHome, getOriginConfigFileName(controlPlaneUrl));
}

export function getLegacyConfigPath(helperHome = getHelperHome()): string {
  return join(helperHome, 'config.json');
}

export function ensureHelperDirectories(helperHome = getHelperHome()): void {
  for (const directory of [
    helperHome,
    join(helperHome, 'data'),
    join(helperHome, 'logs'),
    join(helperHome, 'chrome-profile'),
  ]) mkdirSync(directory, { recursive: true });
}

export function migrateLegacyConfig(helperHome = getHelperHome()): LegacyConfigMigration {
  const legacyPath = getLegacyConfigPath(helperHome);
  if (!existsSync(legacyPath)) return { status: 'missing' };

  const config = readConfigFile(legacyPath);
  if (!config) return { status: 'invalid' };

  const configPath = getConfigPath(config.controlPlaneUrl, helperHome);
  if (existsSync(configPath)) {
    return { status: 'already-migrated', controlPlaneUrl: config.controlPlaneUrl, configPath };
  }

  writeConfig(config, helperHome);
  return { status: 'migrated', controlPlaneUrl: config.controlPlaneUrl, configPath };
}

export function readConfig(
  controlPlaneUrl = PRODUCTION_CONTROL_PLANE_URL,
  helperHome = getHelperHome(),
): HelperConfig | null {
  const expectedOrigin = normalizeOrigin(controlPlaneUrl);
  const config = readConfigFile(getConfigPath(expectedOrigin, helperHome));
  if (!config || normalizeOrigin(config.controlPlaneUrl) !== expectedOrigin) return null;
  return config;
}

export function writeConfig(config: HelperConfig, helperHome = getHelperHome()): void {
  const controlPlaneUrl = normalizeOrigin(config.controlPlaneUrl);
  ensureHelperDirectories(helperHome);
  writeFileSync(
    getConfigPath(controlPlaneUrl, helperHome),
    JSON.stringify({ ...config, controlPlaneUrl }, null, 2),
    { mode: 0o600 },
  );
}

function readConfigFile(configPath: string): HelperConfig | null {
  try {
    const value = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<HelperConfig>;
    if (
      value.schemaVersion !== 1
      || !isNonEmptyString(value.controlPlaneUrl)
      || !isNonEmptyString(value.helperId)
      || !isNonEmptyString(value.encryptedDeviceSecret)
      || !isNonEmptyString(value.deviceName)
      || !isNonEmptyString(value.pairedAt)
    ) return null;
    return {
      schemaVersion: 1,
      controlPlaneUrl: normalizeOrigin(value.controlPlaneUrl),
      helperId: value.helperId,
      encryptedDeviceSecret: value.encryptedDeviceSecret,
      deviceName: value.deviceName,
      pairedAt: value.pairedAt,
    };
  } catch {
    return null;
  }
}

function getOriginConfigFileName(controlPlaneUrl: string): string {
  const origin = normalizeOrigin(controlPlaneUrl);
  if (origin === PRODUCTION_CONTROL_PLANE_URL) return 'config.production.json';

  const url = new URL(origin);
  const originLabel = [
    url.hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '-'),
    url.port || (url.protocol === 'https:' ? '443' : '80'),
  ].join('-');
  const originHash = createHash('sha256').update(origin).digest('hex').slice(0, 10);
  return `config.${originLabel}.${originHash}.json`;
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
