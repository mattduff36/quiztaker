import assert from 'node:assert/strict';
import test from 'node:test';
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
