import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { capabilities } from '../dist/index.js';

const require = createRequire(import.meta.url);
const legacy = require('../../../lib/capabilities.js');

test('legacy capability registry matches the hosted manifest', () => {
  const hosted = capabilities.map((item) => ({
    id: item.id,
    version: item.version,
    script: item.script,
    effect: item.effect,
    requiresConfirmation: item.requiresConfirmation,
    mutatesCourse: item.mutatesCourse,
    verifier: item.verifier,
  }));
  const local = legacy.CAPABILITIES.map((item) => ({
    id: item.id,
    version: item.version,
    script: item.script,
    effect: item.effect,
    requiresConfirmation: item.requiresConfirmation,
    mutatesCourse: item.mutatesCourse,
    verifier: item.verifier,
  }));
  assert.deepEqual(local, hosted);
  assert.equal(local.some((item) => String(item.script).startsWith('pw-quiz-')), false);
});
