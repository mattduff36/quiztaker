import type { HelperRelease } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';
import { getReleaseManifestUrl, parseGitHubRelease } from '@/lib/release-parser';

interface ReleaseResponse {
  ok: boolean;
  url: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface ReleaseFetchInit extends RequestInit {
  next?: {
    revalidate: number;
  };
}

export interface ReleaseFetch {
  (input: string, init?: ReleaseFetchInit): Promise<ReleaseResponse>;
}

const GITHUB_ORIGIN = 'https://github.com';
const RELEASE_REVALIDATE_SECONDS = 300;

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
      const manifestResponse = await fetchRelease(manifestUrl, {
        next: { revalidate: RELEASE_REVALIDATE_SECONDS },
      });
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
  try {
    const response = await fetchRelease(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
    if (response.ok) return await response.json();
  } catch {
    // Public GitHub pages provide a rate-limit-independent local fallback.
  }

  return loadLatestReleaseFromPublicPage(repository, fetchRelease);
}

async function loadLatestReleaseFromPublicPage(
  repository: string,
  fetchRelease: ReleaseFetch,
): Promise<unknown | null> {
  try {
    const releasePageResponse = await fetchRelease(`${GITHUB_ORIGIN}/${repository}/releases/latest`, {
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
    if (!releasePageResponse.ok) return null;

    const tagName = getReleaseTagName(releasePageResponse.url, repository);
    if (!tagName) return null;

    const releasePage = await releasePageResponse.text();
    const publishedAt = getPublishedAt(releasePage);
    if (!publishedAt) return null;

    const assetsResponse = await fetchRelease(
      `${GITHUB_ORIGIN}/${repository}/releases/expanded_assets/${encodeURIComponent(tagName)}`,
      { next: { revalidate: RELEASE_REVALIDATE_SECONDS } },
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
