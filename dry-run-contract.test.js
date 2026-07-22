const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CAPABILITIES, isMutatingRun } = require('./lib/capabilities');
const { authorizeRun } = require('./lib/plan-policy');

test('every mutating executor exposes a read-only dry-run contract', () => {
  for (const capability of CAPABILITIES.filter((item) => item.mutatesCourse)) {
    assert.deepEqual(capability.dryRunArgs, ['--dry'], capability.id);
    const source = fs.readFileSync(path.join(__dirname, capability.script), 'utf8');
    assert.match(source, /--dry/, capability.script);
    assert.equal(isMutatingRun(capability.script, ['0', '--dry']), false, capability.id);
    assert.equal(authorizeRun({
      script: capability.script,
      args: ['0', '--dry'],
    }).ok, true, capability.id);
  }
});
