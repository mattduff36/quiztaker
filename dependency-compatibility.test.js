const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

// Next's plugin uses only globSync(pattern, { onlyDirectories: true }).
// Keep this integration test while its vulnerable fast-glob chain is replaced.
test('Next lint root discovery retains directory globs with tinyglobby', () => {
  const webRequire = createRequire(path.resolve('apps/web/package.json'));
  const pluginRequire = createRequire(webRequire.resolve('@next/eslint-plugin-next'));
  const { getRootDirs } = pluginRequire('./utils/get-root-dirs');
  const root = mkdtempSync(path.join(tmpdir(), 'vitriol-lint-'));
  try {
    mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    mkdirSync(path.join(root, 'apps', 'admin'), { recursive: true });
    writeFileSync(path.join(root, 'apps', 'file.txt'), 'not a directory');
    const normalize = values => values.map(v => v.replaceAll('\\', '/').replace(/\/$/, '')).sort();
    const expected = normalize([path.join(root, 'apps', 'web'), path.join(root, 'apps', 'admin')]);
    assert.deepEqual(normalize(getRootDirs({ cwd: root, settings: { next: { rootDir: path.join(root, 'apps', '*') } } })), expected);
    assert.deepEqual(normalize(getRootDirs({ cwd: root, settings: { next: { rootDir: [path.join(root, 'apps', 'web'), path.join(root, 'apps', 'admin')] } } })), expected);
    assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
