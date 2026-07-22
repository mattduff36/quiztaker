import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveControlPlaneUrl } from '../src/pairing.js';

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
