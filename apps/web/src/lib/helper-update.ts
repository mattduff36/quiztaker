import type { HelperRelease } from '@quiztaker/core';
import { compareVersions } from '@/lib/releases';

export interface HelperUpdateState {
  needed: boolean;
  protocolBlocked: boolean;
  currentVersion: string;
  latestVersion: string | null;
  installerAvailable: boolean;
  canSelfUpdate: boolean;
  mode: 'none' | 'download' | 'queue';
  requestedVersion: string | null;
  error: string | null;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export function describeHelperUpdate(input: {
  currentVersion: string;
  protocolVersion: number;
  supportsSelfUpdate: boolean;
  requestedVersion?: string | null;
  error?: string | null;
  release: HelperRelease | null;
}): HelperUpdateState {
  const protocolBlocked = input.protocolVersion < 2;
  const latestVersion = input.release?.version ?? null;
  const versionOk = RELEASE_VERSION.test(latestVersion ?? '');
  const newer = Boolean(versionOk && input.release && compareVersions(input.release.version, input.currentVersion) > 0);
  const needed = Boolean(input.release) && (newer || (protocolBlocked && versionOk));
  const installerAvailable = Boolean(input.release?.installerUrl);
  const canSelfUpdate = Boolean(
    newer
    && input.supportsSelfUpdate
    && SHA256.test(input.release?.sha256 ?? '')
    && versionOk,
  );
  let mode: HelperUpdateState['mode'] = 'none';
  if (needed && canSelfUpdate) mode = 'queue';
  else if (needed) mode = 'download';
  return {
    needed,
    protocolBlocked,
    currentVersion: input.currentVersion,
    latestVersion,
    installerAvailable,
    canSelfUpdate,
    mode,
    requestedVersion: input.requestedVersion ?? null,
    error: input.error ?? null,
  };
}

export function isTrustedBrowserDownload(url: string, repository: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false;
    if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
    const prefix = `/${repository}/releases/download/`;
    if (!parsed.pathname.startsWith(prefix)) return false;
    const rest = parsed.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || rest.slice(slash + 1).includes('/')) return false;
    const name = decodeURIComponent(rest.slice(slash + 1));
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
    return /^vitriol-helper-windows-x64-v\d+\.\d+\.\d+\.zip$/i.test(name)
      || /^VitriolHelper-\d+\.\d+\.\d+-win-x64\.msi$/i.test(name);
  } catch {
    return false;
  }
}
