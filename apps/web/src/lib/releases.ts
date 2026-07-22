import type { HelperRelease } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { getReleaseManifestUrl, parseGitHubRelease } from '@/lib/release-parser';

interface ReleaseResponse {
  ok: boolean;
  url: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface ReleaseFetch {
  (input: string, init?: RequestInit): Promise<ReleaseResponse>;
}

const GITHUB_ORIGIN = 'https://github.com';
const FRESH_RELEASE_REQUEST: RequestInit = { cache: 'no-store' };

export async function getLatestHelperRelease(): Promise<HelperRelease | null> {
  const repository = getServerEnv().GITHUB_REPOSITORY;
  return loadLatestHelperRelease(repository);
}

export async function loadLatestHelperRelease(
  repository: string,
  fetchRelease: ReleaseFetch = fetch,
): Promise<HelperRelease | null> {
  const release = await loadLatestRelease(repository, fetchRelease);
  if (!release) return null;

  const manifestUrl = getReleaseManifestUrl(release);
  let manifest: unknown;
  if (manifestUrl) {
    try {
      const manifestResponse = await fetchRelease(manifestUrl, FRESH_RELEASE_REQUEST);
      if (manifestResponse.ok) manifest = await manifestResponse.json();
    } catch {
      // The ZIP remains usable when optional integrity metadata is unavailable.
    }
  }
  return parseGitHubRelease(release, manifest);
}

async function loadLatestRelease(
  repository: string,
  fetchRelease: ReleaseFetch,
): Promise<unknown | null> {
  const [apiRelease, publicPageRelease] = await Promise.all([
    loadLatestReleaseFromApi(repository, fetchRelease),
    loadLatestReleaseFromPublicPage(repository, fetchRelease),
  ]);
  return getNewestRelease([apiRelease, publicPageRelease]);
}

async function loadLatestReleaseFromApi(
  repository: string,
  fetchRelease: ReleaseFetch,
): Promise<unknown | null> {
  try {
    const response = await fetchRelease(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (response.ok) return await response.json();
  } catch {
    // The public release page is loaded independently as a fallback.
  }
  return null;
}

async function loadLatestReleaseFromPublicPage(
  repository: string,
  fetchRelease: ReleaseFetch,
): Promise<unknown | null> {
  try {
    const releasePageResponse = await fetchRelease(
      `${GITHUB_ORIGIN}/${repository}/releases/latest`,
      FRESH_RELEASE_REQUEST,
    );
    if (!releasePageResponse.ok) return null;

    const tagName = getReleaseTagName(releasePageResponse.url, repository);
    if (!tagName) return null;

    const releasePage = await releasePageResponse.text();
    const publishedAt = getPublishedAt(releasePage);
    if (!publishedAt) return null;

    const assetsResponse = await fetchRelease(
      `${GITHUB_ORIGIN}/${repository}/releases/expanded_assets/${encodeURIComponent(tagName)}`,
      FRESH_RELEASE_REQUEST,
    );
    if (!assetsResponse.ok) return null;

    return {
      tag_name: tagName,
      published_at: publishedAt,
      assets: getReleaseAssets(await assetsResponse.text(), repository, tagName),
    };
  } catch {
    return null;
  }
}

function getNewestRelease(releases: unknown[]): unknown | null {
  return releases.reduce<unknown | null>((newestRelease, release) => {
    const candidate = release ? parseGitHubRelease(release) : null;
    if (!candidate) return newestRelease;

    const newest = newestRelease ? parseGitHubRelease(newestRelease) : null;
    if (!newest) return release;

    const publishedDifference = Date.parse(candidate.publishedAt) - Date.parse(newest.publishedAt);
    if (publishedDifference > 0) return release;
    if (publishedDifference < 0) return newestRelease;
    return compareVersions(candidate.version, newest.version) > 0 ? release : newestRelease;
  }, null);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function getReleaseTagName(responseUrl: string, repository: string): string | null {
  const releaseUrl = new URL(responseUrl);
  const expectedPrefix = `/${repository}/releases/tag/`;
  if (releaseUrl.origin !== GITHUB_ORIGIN || !releaseUrl.pathname.startsWith(expectedPrefix)) return null;

  const encodedTagName = releaseUrl.pathname.slice(expectedPrefix.length);
  if (!encodedTagName || encodedTagName.includes('/')) return null;
  return decodeURIComponent(encodedTagName);
}

function getPublishedAt(releasePage: string): string | null {
  return releasePage.match(/released this\s*<relative-time[^>]*\sdatetime="([^"]+)"/i)?.[1] ?? null;
}

function getReleaseAssets(releaseAssetsPage: string, repository: string, tagName: string) {
  const expectedPrefix = `/${repository}/releases/download/${encodeURIComponent(tagName)}/`;
  return Array.from(releaseAssetsPage.matchAll(/href="([^"]+)"/g)).flatMap((match) => {
    const assetUrl = new URL(match[1].replaceAll('&amp;', '&'), GITHUB_ORIGIN);
    if (assetUrl.origin !== GITHUB_ORIGIN || !assetUrl.pathname.startsWith(expectedPrefix)) return [];

    const encodedAssetName = assetUrl.pathname.slice(expectedPrefix.length);
    if (!encodedAssetName || encodedAssetName.includes('/')) return [];
    return [{
      name: decodeURIComponent(encodedAssetName),
      browser_download_url: assetUrl.href,
    }];
  });
}
