import type { HelperRelease } from '@quiztaker/core';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface ParsedGitHubRelease {
  tagName: string;
  publishedAt: string;
  assets: GitHubAsset[];
}

const HELPER_ZIP_PATTERN = /^vitriol-helper-windows-x64-v.*\.zip$/i;

export function parseGitHubRelease(
  value: unknown,
  manifestValue?: unknown,
): HelperRelease | null {
  const release = parseRelease(value);
  if (!release) return null;

  const zip = release.assets.find((asset) => HELPER_ZIP_PATTERN.test(asset.name));
  if (!zip) return null;

  const manifest = isRecord(manifestValue) ? manifestValue : {};
  return {
    version: release.tagName.replace(/^v/, ''),
    publishedAt: release.publishedAt,
    downloadUrl: zip.browser_download_url,
    sha256: typeof manifest.sha256 === 'string' ? manifest.sha256 : '',
    minimumHelperVersion: typeof manifest.minimumHelperVersion === 'string'
      ? manifest.minimumHelperVersion
      : '1.0.0',
  };
}

export function getReleaseManifestUrl(value: unknown): string | null {
  const release = parseRelease(value);
  return release?.assets.find((asset) => asset.name === 'release.json')?.browser_download_url ?? null;
}

function parseRelease(value: unknown): ParsedGitHubRelease | null {
  if (!isRecord(value)) return null;
  if (typeof value.tag_name !== 'string' || typeof value.published_at !== 'string') return null;
  if (!Array.isArray(value.assets)) return null;

  const assets = value.assets.flatMap((asset) => {
    if (!isRecord(asset)) return [];
    if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return [];
    return [{ name: asset.name, browser_download_url: asset.browser_download_url }];
  });

  return {
    tagName: value.tag_name,
    publishedAt: value.published_at,
    assets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
