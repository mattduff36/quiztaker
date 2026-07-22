import type { HelperRelease } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { getReleaseManifestUrl, parseGitHubRelease } from '@/lib/release-parser';

export async function getLatestHelperRelease(): Promise<HelperRelease | null> {
  const repository = getServerEnv().GITHUB_REPOSITORY;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    next: { revalidate: 300 },
  });
  if (!response.ok) return null;
  const release = await response.json() as unknown;
  const manifestUrl = getReleaseManifestUrl(release);
  let manifest: unknown;
  if (manifestUrl) {
    const manifestResponse = await fetch(manifestUrl, { next: { revalidate: 300 } });
    if (manifestResponse.ok) manifest = await manifestResponse.json() as unknown;
  }
  return parseGitHubRelease(release, manifest);
}
