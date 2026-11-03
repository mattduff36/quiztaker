import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHelperUpdateAllowsJob } from '../src/lib/jobs';

test('update admission blocks requested and in-progress jobs while preserving recovery', () => {
  for (const state of [{update_requested_version:'1.0.21'}, ...['requested','preparing','downloading','installing','unknown-phase'].map(phase => ({update_requested_version:'1.0.21',update_phase:phase}))]) {
    assert.throws(() => assertHelperUpdateAllowsJob('quiz-learn',state),/helper is updating/);
    assert.throws(() => assertHelperUpdateAllowsJob('cert-batch',state),/helper is updating/);
    assert.doesNotThrow(() => assertHelperUpdateAllowsJob('close-browser',state));
  }
  for (const state of [{}, {update_requested_version:'1.0.21',update_error:'Download failed'}, {update_requested_version:'1.0.21',update_phase:'requested',update_error:'Legacy download failed'}, ...['failed','reconnected'].map(phase => ({update_requested_version:'1.0.21',update_phase:phase}))]) {
    assert.doesNotThrow(() => assertHelperUpdateAllowsJob('quiz-learn',state));
  }
});
