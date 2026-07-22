import type { HelperRelease } from '@quiztaker/core';
import { getServerEnv } from '@/lib/env';

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export async function getLatestHelperRelease(): Promise<HelperRelease | null> {
  const repository = getServerEnv().GITHUB_REPOSITORY;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    next: { revalidate: 300 },
  });
  if (!response.ok) return null;
  const release = await response.json() as GitHubRelease;
  const zip = release.assets.find((asset) => /^quiztaker-helper-windows-x64-v.*\.zip$/i.test(asset.name));
  const manifestAsset = release.assets.find((asset) => asset.name === 'release.json');
  if (!zip) return null;
  let sha256 = '';
  let minimumHelperVersion = '1.0.0';
  if (manifestAsset) {
    const manifestResponse = await fetch(manifestAsset.browser_download_url, { next: { revalidate: 300 } });
    if (manifestResponse.ok) {
      const manifest = await manifestResponse.json() as { sha256?: string; minimumHelperVersion?: string };
      sha256 = manifest.sha256 || '';
      minimumHelperVersion = manifest.minimumHelperVersion || minimumHelperVersion;
    }
  }
  return {
    version: release.tag_name.replace(/^v/, ''),
    publishedAt: release.published_at,
    downloadUrl: zip.browser_download_url,
    sha256,
    minimumHelperVersion,
  };
}
