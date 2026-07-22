import assert from 'node:assert/strict';
import test from 'node:test';
import { getReleaseManifestUrl, parseGitHubRelease } from '../src/lib/release-parser.js';

const validRelease = {
  tag_name: 'v1.0.0',
  published_at: '2026-07-22T16:00:00.000Z',
  assets: [
    {
      name: 'vitriol-helper-windows-x64-v1.0.0.zip',
      browser_download_url: 'https://example.com/vitriol-helper.zip',
    },
    {
      name: 'release.json',
      browser_download_url: 'https://example.com/release.json',
    },
  ],
};

test('parses a Vitriol helper release and manifest', () => {
  assert.deepEqual(parseGitHubRelease(validRelease, {
    sha256: 'abc123',
    minimumHelperVersion: '1.0.0',
  }), {
    version: '1.0.0',
    publishedAt: '2026-07-22T16:00:00.000Z',
    downloadUrl: 'https://example.com/vitriol-helper.zip',
    sha256: 'abc123',
    minimumHelperVersion: '1.0.0',
  });
  assert.equal(getReleaseManifestUrl(validRelease), 'https://example.com/release.json');
});

test('uses safe manifest defaults when release metadata is absent', () => {
  assert.deepEqual(parseGitHubRelease(validRelease), {
    version: '1.0.0',
    publishedAt: '2026-07-22T16:00:00.000Z',
    downloadUrl: 'https://example.com/vitriol-helper.zip',
    sha256: '',
    minimumHelperVersion: '1.0.0',
  });
});

test('rejects a release without the Vitriol ZIP asset', () => {
  assert.equal(parseGitHubRelease({
    ...validRelease,
    assets: [{ name: 'release.json', browser_download_url: 'https://example.com/release.json' }],
  }), null);
});

test('rejects malformed GitHub release data', () => {
  assert.equal(parseGitHubRelease(null), null);
  assert.equal(parseGitHubRelease({ tag_name: 'v1.0.0', assets: [] }), null);
  assert.equal(getReleaseManifestUrl({ assets: 'invalid' }), null);
});
