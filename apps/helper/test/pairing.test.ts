import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfigPath, readConfig, writeConfig } from '../src/config.js';
import {
  parsePairingLaunch,
  resolveControlPlaneUrl,
  resolveHelperLaunch,
} from '../src/pairing.js';

test('uses the production control plane without an unnecessary prompt', () => {
  assert.equal(resolveControlPlaneUrl([]), 'https://www.vitriol.co.uk');
  assert.deepEqual(resolveHelperLaunch([]), {
    controlPlaneUrl: 'https://www.vitriol.co.uk',
    mode: 'production',
    pairing: null,
  });
  assert.deepEqual(resolveHelperLaunch(['--production']), {
    controlPlaneUrl: 'https://www.vitriol.co.uk',
    mode: 'production',
    pairing: null,
  });
});

test('accepts an explicit secure control-plane URL', () => {
  assert.equal(
    resolveControlPlaneUrl(['--control-plane-url=https://preview.vitriol.co.uk/path']),
    'https://preview.vitriol.co.uk',
  );
});

test('allows local HTTP development and rejects remote HTTP', () => {
  assert.equal(
    resolveControlPlaneUrl(['--control-plane-url=http://localhost:4000/helper']),
    'http://localhost:4000',
  );
  assert.deepEqual(
    resolveHelperLaunch(['--control-plane-url=http://localhost:4000/helper']),
    {
      controlPlaneUrl: 'http://localhost:4000',
      mode: 'local-development',
      pairing: null,
    },
  );
  assert.throws(
    () => resolveControlPlaneUrl(['--control-plane-url=http://vitriol.co.uk']),
    /must use HTTPS/,
  );
  assert.throws(
    () => resolveControlPlaneUrl(['--control-plane-url=ftp://localhost:4000']),
    /must use HTTPS/,
  );
});

test('rejects conflicting explicit launch modes', () => {
  assert.throws(
    () => resolveControlPlaneUrl([
      '--production',
      '--control-plane-url=http://localhost:4000',
    ]),
    /either --production or --control-plane-url/,
  );
});

test('reads an origin-specific pairing launch link', () => {
  const pairing = {
    code: 'ABCD2345',
    controlPlaneUrl: 'http://localhost:4000',
  };
  assert.deepEqual(parsePairingLaunch([
    'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=http%3A%2F%2Flocalhost%3A4000',
  ]), pairing);
  assert.deepEqual(resolveHelperLaunch([
    'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=http%3A%2F%2Flocalhost%3A4000',
  ]), {
    controlPlaneUrl: 'http://localhost:4000',
    mode: 'local-development',
    pairing,
  });
  assert.deepEqual(resolveHelperLaunch([
    '--production',
    'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=http%3A%2F%2Flocalhost%3A4000',
  ]), {
    controlPlaneUrl: 'http://localhost:4000',
    mode: 'local-development',
    pairing,
  });
  assert.equal(parsePairingLaunch([]), null);
});

test('rejects unsafe or malformed pairing launch links', () => {
  assert.throws(
    () => parsePairingLaunch([
      'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=http%3A%2F%2Fvitriol.co.uk',
    ]),
    /must use HTTPS/,
  );
  assert.throws(
    () => parsePairingLaunch([
      'vitriol-helper://other?code=ABCD2345&controlPlaneUrl=https%3A%2F%2Fwww.vitriol.co.uk',
    ]),
    /launch link is invalid/,
  );
  assert.throws(
    () => parsePairingLaunch([
      'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=https%3A%2F%2Fexample.com',
    ]),
    /target is not trusted/,
  );
});

test('opens production without pairing and selects explicit trusted origins', () => {
  assert.deepEqual(resolveHelperLaunch(['vitriol-helper://open']), {
    controlPlaneUrl: 'https://www.vitriol.co.uk',
    mode: 'production',
    pairing: null,
  });
  assert.equal(parsePairingLaunch(['vitriol-helper://open']), null);
  assert.deepEqual(resolveHelperLaunch(['vitriol-helper://open/']), resolveHelperLaunch(['vitriol-helper://open']));
  for (const target of ['https://www.vitriol.co.uk', 'https://vitriol.co.uk', 'http://localhost:4000', 'http://127.0.0.1:3000']) {
    const args = [`vitriol-helper://open?controlPlaneUrl=${encodeURIComponent(target)}`];
    assert.equal(resolveHelperLaunch(args).controlPlaneUrl, target);
    assert.equal(resolveHelperLaunch(args).pairing, null);
    assert.equal(resolveControlPlaneUrl(args), target);
  }
});

test('opening resolves the existing origin pairing without changing saved credentials', () => {
  const helperHome = mkdtempSync(join(tmpdir(), 'vitriol-helper-open-'));
  try {
    for (const target of ['https://www.vitriol.co.uk', 'http://localhost:4000']) {
      const config = {
        schemaVersion: 1 as const,
        controlPlaneUrl: target,
        helperId: 'existing-helper',
        encryptedDeviceSecret: 'dpapi:existing-secret',
        deviceName: 'Existing device',
        pairedAt: '2026-11-03T00:00:00.000Z',
      };
      writeConfig(config, helperHome);
      const path = getConfigPath(target, helperHome);
      const before = readFileSync(path, 'utf8');
      const launch = resolveHelperLaunch([`vitriol-helper://open?controlPlaneUrl=${encodeURIComponent(target)}`]);
      assert.equal(launch.pairing, null);
      assert.deepEqual(readConfig(launch.controlPlaneUrl, helperHome), config);
      assert.equal(readFileSync(path, 'utf8'), before);
    }
  } finally {
    rmSync(helperHome, { recursive: true, force: true });
  }
});

test('rejects unsafe, ambiguous, and credential-bearing protocol launches', () => {
  const unsafeTargets = [
    'https://example.com', 'http://www.vitriol.co.uk', 'ftp://localhost',
    'https://www.vitriol.co.uk.attacker.com', 'https://user:secret@www.vitriol.co.uk',
    'http://user@localhost:4000', 'https://www.vitriol.co.uk/helper',
    'https://www.vitriol.co.uk?code=SECRET', 'http://localhost:4000#fragment',
  ];
  const unsafeLinks = [
    'vitriol-helper://open/path', 'vitriol-helper://open#fragment',
    'vitriol-helper://user:secret@open', 'vitriol-helper://open:123',
    'vitriol-helper://open?code=ABCD2345', 'vitriol-helper://open?unknown=value',
    'vitriol-helper://open?controlPlaneUrl=',
    'vitriol-helper://open?controlPlaneUrl=https://www.vitriol.co.uk&controlPlaneUrl=http://localhost:4000',
    'vitriol-helper://pair?code=ABCD2345&code=XXXX2345&controlPlaneUrl=https://www.vitriol.co.uk',
    ...unsafeTargets.map((target) => `vitriol-helper://open?controlPlaneUrl=${encodeURIComponent(target)}`),
  ];
  for (const link of unsafeLinks) assert.throws(() => resolveHelperLaunch([link]), link);
  assert.throws(() => resolveHelperLaunch(['vitriol-helper://open', 'vitriol-helper://open']), /Only one/);
  assert.throws(() => resolveHelperLaunch([
    'vitriol-helper://open',
    'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=https://www.vitriol.co.uk',
  ]), /Only one/);
});
