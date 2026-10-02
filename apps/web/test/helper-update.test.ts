import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHelperUpdate, isTrustedBrowserDownload } from '../src/lib/helper-update.js';
import type { HelperRelease } from '@quiztaker/core';

const release = (version: string, extras: Partial<HelperRelease> = {}): HelperRelease => ({
  version,
  publishedAt: '2026-10-02T15:00:00.000Z',
  downloadUrl: `https://github.com/mattduff36/quiztaker/releases/download/v${version}/vitriol-helper-windows-x64-v${version}.zip`,
  sha256: 'a'.repeat(64),
  minimumHelperVersion: '1.0.0',
  installerUrl: `https://github.com/mattduff36/quiztaker/releases/download/v${version}/VitriolHelper-${version}-win-x64.msi`,
  installerSha256: 'def456',
  ...extras,
});

test('protocol 1 helpers download the installer instead of installing it themselves', () => {
  const state = describeHelperUpdate({
    currentVersion: '1.0.2',
    protocolVersion: 1,
    supportsSelfUpdate: false,
    release: release('1.0.4'),
  });
  assert.equal(state.needed, true);
  assert.equal(state.protocolBlocked, true);
  assert.equal(state.mode, 'download');
  assert.equal(state.canSelfUpdate, false);
  assert.equal(state.installerAvailable, true);
});

test('a current self-updating helper queues the newer release', () => {
  const state = describeHelperUpdate({
    currentVersion: '1.0.4',
    protocolVersion: 2,
    supportsSelfUpdate: true,
    release: release('1.0.5'),
  });
  assert.equal(state.protocolBlocked, false);
  assert.equal(state.mode, 'queue');
});

test('an up-to-date protocol 2 helper does not offer an update', () => {
  const state = describeHelperUpdate({
    currentVersion: '1.0.4',
    protocolVersion: 2,
    supportsSelfUpdate: true,
    release: release('1.0.4'),
  });
  assert.equal(state.needed, false);
  assert.equal(state.mode, 'none');
});

test('a missing checksum falls back to a browser download', () => {
  const state = describeHelperUpdate({
    currentVersion: '1.0.4',
    protocolVersion: 2,
    supportsSelfUpdate: true,
    release: release('1.0.5', { sha256: '' }),
  });
  assert.equal(state.mode, 'download');
});

test('browser downloads stay on this repository\'s release assets', () => {
  const repository = 'mattduff36/quiztaker';
  assert.equal(isTrustedBrowserDownload(release('1.0.4').downloadUrl, repository), true);
  assert.equal(isTrustedBrowserDownload(release('1.0.4').installerUrl || '', repository), true);
  assert.equal(isTrustedBrowserDownload('https://example.com/VitriolHelper-1.0.4-win-x64.msi', repository), false);
  assert.equal(isTrustedBrowserDownload(`${release('1.0.4').downloadUrl}?x=1`, repository), false);
  assert.equal(isTrustedBrowserDownload('https://github.com/mattduff36/quiztaker/releases/download/v1.0.4/release.json', repository), false);
});
