import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadLatestHelperRelease,
  type ReleaseFetch,
} from '../src/lib/releases.js';

const repository = 'mattduff36/quiztaker';
const tagName = 'v1.0.0';
const releasePageUrl = `https://github.com/${repository}/releases/tag/${tagName}`;
const zipUrl = `https://github.com/${repository}/releases/download/${tagName}/vitriol-helper-windows-x64-v1.0.0.zip`;
const manifestUrl = `https://github.com/${repository}/releases/download/${tagName}/release.json`;

test('falls back to the public release page when the GitHub API is rate-limited', async () => {
  const requestedUrls: string[] = [];
  const requestCacheModes: Array<RequestCache | undefined> = [];
  const fetchRelease: ReleaseFetch = async (url, init) => {
    requestedUrls.push(url);
    requestCacheModes.push(init?.cache);
    if (url === `https://api.github.com/repos/${repository}/releases/latest`) {
      return createResponse({ ok: false });
    }
    if (url === `https://github.com/${repository}/releases/latest`) {
      return createResponse({
        url: releasePageUrl,
        text: '<p>github-actions released this <relative-time datetime="2026-07-22T17:00:05Z"></relative-time></p>',
      });
    }
    if (url === `https://github.com/${repository}/releases/expanded_assets/${tagName}`) {
      return createResponse({
        text: [
          `<a href="/${repository}/releases/download/${tagName}/release.json">release.json</a>`,
          `<a href="/${repository}/releases/download/${tagName}/vitriol-helper-windows-x64-v1.0.0.zip">helper</a>`,
        ].join(''),
      });
    }
    if (url === manifestUrl) {
      return createResponse({
        json: {
          sha256: 'abc123',
          minimumHelperVersion: '1.0.0',
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  assert.deepEqual(await loadLatestHelperRelease(repository, fetchRelease), {
    version: '1.0.0',
    publishedAt: '2026-07-22T17:00:05Z',
    downloadUrl: zipUrl,
    sha256: 'abc123',
    minimumHelperVersion: '1.0.0',
  });
  assert.deepEqual(requestedUrls, [
    `https://api.github.com/repos/${repository}/releases/latest`,
    `https://github.com/${repository}/releases/latest`,
    `https://github.com/${repository}/releases/expanded_assets/${tagName}`,
    manifestUrl,
  ]);
  assert.deepEqual(requestCacheModes, ['no-store', 'no-store', 'no-store', 'no-store']);
});

test('prefers newer fallback metadata when the primary API response is stale', async () => {
  const newerTagName = 'v1.0.1';
  const newerPublishedAt = '2026-07-22T23:18:05Z';
  const newerZipUrl = getZipUrl(newerTagName);
  const fetchRelease: ReleaseFetch = async (url) => {
    if (url.includes('api.github.com')) {
      return createResponse({
        json: createRelease(tagName, '2026-07-22T17:00:05Z'),
      });
    }
    if (url.endsWith('/releases/latest')) {
      return createResponse({
        url: `https://github.com/${repository}/releases/tag/${newerTagName}`,
        text: getReleasePage(newerPublishedAt),
      });
    }
    if (url.includes('/releases/expanded_assets/')) {
      return createResponse({ text: getAssetsPage(newerTagName) });
    }
    if (url.endsWith('/release.json')) {
      return createResponse({ json: { sha256: 'newer-sha' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  assert.deepEqual(await loadLatestHelperRelease(repository, fetchRelease), {
    version: '1.0.1',
    publishedAt: newerPublishedAt,
    downloadUrl: newerZipUrl,
    sha256: 'newer-sha',
    minimumHelperVersion: '1.0.0',
  });
});

test('prefers newer primary metadata when the public page response is stale', async () => {
  const newerTagName = 'v1.0.1';
  const newerPublishedAt = '2026-07-22T23:18:05Z';
  const fetchRelease: ReleaseFetch = async (url) => {
    if (url.includes('api.github.com')) {
      return createResponse({
        json: createRelease(newerTagName, newerPublishedAt),
      });
    }
    if (url.endsWith('/releases/latest')) {
      return createResponse({
        url: releasePageUrl,
        text: getReleasePage('2026-07-22T17:00:05Z'),
      });
    }
    if (url.includes('/releases/expanded_assets/')) {
      return createResponse({ text: getAssetsPage(tagName) });
    }
    if (url.endsWith('/release.json')) {
      return createResponse({ json: { sha256: 'newer-sha' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  assert.deepEqual(await loadLatestHelperRelease(repository, fetchRelease), {
    version: '1.0.1',
    publishedAt: newerPublishedAt,
    downloadUrl: getZipUrl(newerTagName),
    sha256: 'newer-sha',
    minimumHelperVersion: '1.0.0',
  });
});

test('returns null when neither GitHub source has a published release', async () => {
  const fetchRelease: ReleaseFetch = async () => createResponse({ ok: false });

  assert.equal(await loadLatestHelperRelease(repository, fetchRelease), null);
});

test('returns null when the fallback release has no helper ZIP', async () => {
  const fetchRelease: ReleaseFetch = async (url) => {
    if (url.includes('api.github.com')) return createResponse({ ok: false });
    if (url.endsWith('/releases/latest')) {
      return createResponse({
        url: releasePageUrl,
        text: '<p>github-actions released this <relative-time datetime="2026-07-22T17:00:05Z"></relative-time></p>',
      });
    }
    return createResponse({
      text: `<a href="/${repository}/releases/download/${tagName}/release.json">release.json</a>`,
    });
  };

  assert.equal(await loadLatestHelperRelease(repository, fetchRelease), null);
});

interface ResponseOptions {
  ok?: boolean;
  url?: string;
  json?: unknown;
  text?: string;
}

function createResponse(options: ResponseOptions) {
  return {
    ok: options.ok ?? true,
    url: options.url ?? '',
    async json() {
      return options.json;
    },
    async text() {
      return options.text ?? '';
    },
  };
}

function createRelease(releaseTagName: string, publishedAt: string) {
  return {
    tag_name: releaseTagName,
    published_at: publishedAt,
    assets: [
      {
        name: `vitriol-helper-windows-x64-${releaseTagName}.zip`,
        browser_download_url: getZipUrl(releaseTagName),
      },
      {
        name: 'release.json',
        browser_download_url: `https://github.com/${repository}/releases/download/${releaseTagName}/release.json`,
      },
    ],
  };
}

function getReleasePage(publishedAt: string): string {
  return `<p>github-actions released this <relative-time datetime="${publishedAt}"></relative-time></p>`;
}

function getAssetsPage(releaseTagName: string): string {
  return [
    `<a href="/${repository}/releases/download/${releaseTagName}/release.json">release.json</a>`,
    `<a href="/${repository}/releases/download/${releaseTagName}/vitriol-helper-windows-x64-${releaseTagName}.zip">helper</a>`,
  ].join('');
}

function getZipUrl(releaseTagName: string): string {
  return `https://github.com/${repository}/releases/download/${releaseTagName}/vitriol-helper-windows-x64-${releaseTagName}.zip`;
}
