import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  PRODUCTION_CONTROL_PLANE_URL,
  protectSecret,
  writeConfig,
  type HelperConfig,
} from './config.js';
import { HELPER_VERSION } from './version.js';

interface PairingResponse {
  helperId: string;
  deviceSecret: string;
}

export interface PairingLaunch {
  code: string;
  controlPlaneUrl: string;
}

export interface HelperLaunch {
  controlPlaneUrl: string;
  mode: 'production' | 'local-development' | 'custom';
  pairing: PairingLaunch | null;
}

export async function pairInteractively(args = process.argv.slice(2)): Promise<HelperConfig> {
  const launch = parsePairingLaunch(args);
  if (launch) {
    console.log(`Pairing Vitriol Helper with ${describeControlPlane(launch.controlPlaneUrl)}...`);
    return claimPairing(launch);
  }

  const controlPlaneUrl = resolveControlPlaneUrl(args);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`No pairing is configured for ${describeControlPlane(controlPlaneUrl)}.`);
    console.log(`Generate a pairing code at ${controlPlaneUrl}/helper, then enter it below.`);
    const code = (await prompt.question('Pairing code: ')).trim().toUpperCase();
    if (!code) throw new Error('A pairing code is required.');
    return claimPairing({ code, controlPlaneUrl });
  } finally {
    prompt.close();
  }
}

export function parsePairingLaunch(args: string[]): PairingLaunch | null {
  const value = args.find((argument) => argument.toLowerCase().startsWith('vitriol-helper:'));
  if (!value) return null;
  const launch = new URL(value);
  if (launch.protocol !== 'vitriol-helper:' || launch.hostname !== 'pair') {
    throw new Error('The Vitriol Helper launch link is invalid.');
  }
  const code = (launch.searchParams.get('code') || '').trim().toUpperCase();
  const controlPlaneUrl = normalizeUrl(launch.searchParams.get('controlPlaneUrl') || '');
  if (!/^[A-Z0-9]{6,20}$/.test(code)) throw new Error('The pairing code in the launch link is invalid.');
  const target = new URL(controlPlaneUrl);
  const isLocal = ['localhost', '127.0.0.1'].includes(target.hostname);
  const isProduction = target.protocol === 'https:'
    && ['vitriol.co.uk', 'www.vitriol.co.uk'].includes(target.hostname);
  if (!isLocal && !isProduction) throw new Error('The pairing launch target is not trusted.');
  return { code, controlPlaneUrl };
}

export function resolveControlPlaneUrl(args: string[]): string {
  const isProduction = args.includes('--production');
  const argument = args.find((value) => value.startsWith('--control-plane-url='));
  if (isProduction && argument) {
    throw new Error('Choose either --production or --control-plane-url, not both.');
  }
  return normalizeUrl(
    isProduction
      ? PRODUCTION_CONTROL_PLANE_URL
      : argument?.slice('--control-plane-url='.length) || PRODUCTION_CONTROL_PLANE_URL,
  );
}

export function resolveHelperLaunch(args: string[]): HelperLaunch {
  const pairing = parsePairingLaunch(args);
  const controlPlaneUrl = pairing?.controlPlaneUrl || resolveControlPlaneUrl(args);
  return {
    controlPlaneUrl,
    mode: getControlPlaneMode(controlPlaneUrl),
    pairing,
  };
}

export function describeControlPlane(controlPlaneUrl: string): string {
  const mode = getControlPlaneMode(controlPlaneUrl);
  const label = mode === 'production'
    ? 'production'
    : mode === 'local-development'
      ? 'local development'
      : 'an explicit custom environment';
  return `${label} (${controlPlaneUrl})`;
}

async function claimPairing({ code, controlPlaneUrl }: PairingLaunch): Promise<HelperConfig> {
  const deviceName = hostname();
  const response = await fetch(`${controlPlaneUrl}/api/helper/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName,
      platform: process.platform,
      architecture: process.arch,
      version: HELPER_VERSION,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const value = await response.json() as PairingResponse;
  const config: HelperConfig = {
    schemaVersion: 1,
    controlPlaneUrl,
    helperId: value.helperId,
    encryptedDeviceSecret: protectSecret(value.deviceSecret),
    deviceName,
    pairedAt: new Date().toISOString(),
  };
  writeConfig(config);
  return config;
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  const isLocalHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('The control plane must use HTTPS.');
  }
  return url.origin;
}

function getControlPlaneMode(controlPlaneUrl: string): HelperLaunch['mode'] {
  const target = new URL(controlPlaneUrl);
  if (target.origin === PRODUCTION_CONTROL_PLANE_URL) return 'production';
  if (['localhost', '127.0.0.1'].includes(target.hostname)) return 'local-development';
  return 'custom';
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `Pairing failed with HTTP ${response.status}`;
  } catch {
    return `Pairing failed with HTTP ${response.status}`;
  }
}
