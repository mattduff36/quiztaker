const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

test('Windows helper packaging excludes timed quiz executors', () => {
  const source = readFileSync('apps/helper/packaging/build-windows.mjs', 'utf8');
  assert.equal(source.includes('!/^pw-quiz-/i.test(name)'), true);
});
