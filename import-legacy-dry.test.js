const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('legacy knowledge import dry-run does not require a database', () => {
  const result = spawnSync(process.execPath, ['scripts/import-legacy-knowledge.mjs', '--dry'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(typeof summary.history, 'number');
  assert.equal(typeof summary.strategies, 'number');
  assert.equal(typeof summary.captures, 'number');
  assert.ok(Array.isArray(summary.capabilityVersions));
  const repeat = spawnSync(process.execPath, ['scripts/import-legacy-knowledge.mjs', '--dry'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(repeat.stdout, result.stdout);
});
