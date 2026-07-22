import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { protectSecret, writeConfig, type HelperConfig } from './config.js';
import { HELPER_VERSION } from './version.js';

interface PairingResponse {
  helperId: string;
  deviceSecret: string;
}

export interface PairingLaunch {
  code: string;
  controlPlaneUrl: string;
}

const DEFAULT_CONTROL_PLANE_URL = process.env.QUIZTAKER_CONTROL_PLANE_URL || 'https://www.vitriol.co.uk';

export async function pairInteractively(): Promise<HelperConfig> {
  const args = process.argv.slice(2);
  const launch = parsePairingLaunch(args);
  if (launch) {
    console.log(`Pairing Vitriol Helper with ${launch.controlPlaneUrl}...`);
    return claimPairing(launch);
  }

  const controlPlaneUrl = resolveControlPlaneUrl(args);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`First-time setup: generate a pairing code at ${controlPlaneUrl}/helper.`);
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
  const argument = args.find((value) => value.startsWith('--control-plane-url='));
  return normalizeUrl(argument?.slice('--control-plane-url='.length) || DEFAULT_CONTROL_PLANE_URL);
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
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('The control plane must use HTTPS.');
  }
  return url.origin;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `Pairing failed with HTTP ${response.status}`;
  } catch {
    return `Pairing failed with HTTP ${response.status}`;
  }
}
