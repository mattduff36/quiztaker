import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { protectSecret, unprotectSecret } from '../src/config.js';

test('protects and restores a helper secret with the platform credential store', {
  skip: process.platform !== 'win32',
}, () => {
  const secret = `helper-secret-${randomUUID()}`;
  const protectedSecret = protectSecret(secret);

  assert.match(protectedSecret, /^dpapi:/);
  assert.doesNotMatch(protectedSecret, new RegExp(secret));
  assert.equal(unprotectSecret(protectedSecret), secret);
});
