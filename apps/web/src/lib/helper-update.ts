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
  phase: string | null;
  phaseVersion: string | null;
  phaseUpdatedAt: string | null;
  inProgress: boolean;
  progressLabel: string | null;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export function describeHelperUpdate(input: {
  currentVersion: string;
  protocolVersion: number;
  supportsSelfUpdate: boolean;
  requestedVersion?: string | null;
  error?: string | null;
  phase?: string | null;
  phaseVersion?: string | null;
  phaseUpdatedAt?: string | Date | null;
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
  const phase = input.error ? 'failed' : input.phase ?? (input.requestedVersion ? 'requested' : null);
  const inProgress = Boolean(input.requestedVersion && phase !== 'failed' && phase !== 'reconnected');
  const labels: Record<string, string> = { requested: 'Update requested · waiting for the helper', preparing: 'Preparing the update', downloading: 'Downloading and checking the update', installing: 'Installing · waiting for the helper to reconnect', reconnected: 'Updated helper reconnected', failed: 'The helper update needs attention' };
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
    phase,
    phaseVersion: input.phaseVersion ?? input.requestedVersion ?? null,
    phaseUpdatedAt: input.phaseUpdatedAt instanceof Date ? input.phaseUpdatedAt.toISOString() : input.phaseUpdatedAt ?? null,
    inProgress,
    progressLabel: phase ? labels[phase] || 'Waiting for update progress' : null,
  };
}

export function reportedUpdatePhase(input: { requestedVersion: string | null; reportedVersion: string; phase?: string; phaseVersion?: string }): { phase: string; version: string; reconnected: boolean } | null {
  if (!input.requestedVersion) return null;
  if (compareVersions(input.reportedVersion, input.requestedVersion) >= 0) return { phase: 'reconnected', version: input.requestedVersion, reconnected: true };
  if (input.phaseVersion !== input.requestedVersion || !['preparing', 'downloading', 'installing', 'failed'].includes(input.phase || '')) return null;
  return { phase: input.phase!, version: input.requestedVersion, reconnected: false };
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
