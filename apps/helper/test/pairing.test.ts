import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePairingLaunch, resolveControlPlaneUrl } from '../src/pairing.js';

test('uses the production control plane without an unnecessary prompt', () => {
  assert.equal(resolveControlPlaneUrl([]), 'https://www.vitriol.co.uk');
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
  assert.throws(
    () => resolveControlPlaneUrl(['--control-plane-url=http://vitriol.co.uk']),
    /must use HTTPS/,
  );
});

test('reads an origin-specific pairing launch link', () => {
  assert.deepEqual(parsePairingLaunch([
    'vitriol-helper://pair?code=ABCD2345&controlPlaneUrl=http%3A%2F%2Flocalhost%3A4000',
  ]), {
    code: 'ABCD2345',
    controlPlaneUrl: 'http://localhost:4000',
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
