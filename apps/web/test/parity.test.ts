import assert from 'node:assert/strict';
import test from 'node:test';
import { parityAllows } from '../src/lib/parity.js';

test('new actions can be disabled without removing legacy cards', () => {
  const previous = process.env.PARITY_NEW_ACTIONS;
  process.env.PARITY_NEW_ACTIONS = '0';
  assert.equal(parityAllows('detect'), false);
  assert.equal(parityAllows('open-url'), false);
  assert.equal(parityAllows('list-tabs'), true);
  assert.equal(parityAllows('cert-batch'), true);
  process.env.PARITY_NEW_ACTIONS = previous;
});

