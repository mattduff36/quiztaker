import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHelperUpdate, isTrustedBrowserDownload, reportedUpdatePhase } from '../src/lib/helper-update.js';
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

test('update progress requires matching authenticated version reports and confirms reconnection from the running version', () => {
  const input = { requestedVersion: '1.0.21', reportedVersion: '1.0.19' };
  assert.equal(reportedUpdatePhase(input), null);
  assert.equal(reportedUpdatePhase({ ...input, phase: 'downloading', phaseVersion: '1.0.20' }), null);
  assert.deepEqual(reportedUpdatePhase({ ...input, phase: 'downloading', phaseVersion: '1.0.21' }), { phase: 'downloading', version: '1.0.21', reconnected: false });
  assert.deepEqual(reportedUpdatePhase({ ...input, reportedVersion: '1.0.21' }), { phase: 'reconnected', version: '1.0.21', reconnected: true });
  assert.equal(reportedUpdatePhase({ ...input, requestedVersion: null, phase: 'installing', phaseVersion: '1.0.21' }), null);
});

test('old helpers show requested/waiting and reported failures release the replacement block', () => {
  const input = { currentVersion: '1.0.19', protocolVersion: 2, supportsSelfUpdate: true, requestedVersion: '1.0.21', release: release('1.0.21') };
  const old = describeHelperUpdate(input);
  assert.equal(old.phase, 'requested');
  assert.equal(old.inProgress, true);
  assert.match(old.progressLabel || '', /waiting/);
  assert.doesNotMatch(old.progressLabel || '', /Downloading|Installing/);
  assert.equal(describeHelperUpdate({ ...input, phase: 'downloading' }).progressLabel, 'Downloading and checking the update');
  const failed = describeHelperUpdate({ ...input, phase: 'failed', error: 'Checksum mismatch' });
  assert.equal(failed.inProgress, false);
  assert.equal(failed.phase, 'failed');
  const complete = describeHelperUpdate({ ...input, requestedVersion: null, currentVersion: '1.0.21', phase: 'reconnected', phaseVersion: '1.0.21' });
  assert.equal(complete.inProgress, false);
  assert.match(complete.progressLabel || '', /reconnected/);
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
