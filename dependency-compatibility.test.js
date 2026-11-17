const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

// Next's plugin uses only globSync(pattern, { onlyDirectories: true }).
// Keep this integration test while its vulnerable fast-glob chain is replaced.
test('Next lint root discovery retains absolute directory globs', () => {
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

test('TypeScript lint discovery expands directories and honours hidden files and exclusions', () => {
  const { globSync, isDynamicPattern } = require('tinyglobby');
  const root = mkdtempSync(path.join(tmpdir(), 'vitriol-tsconfig-'));
  try {
    for (const directory of ['src', 'src/.generated', 'src/node_modules']) mkdirSync(path.join(root, directory));
    for (const file of ['src/app.ts', 'src/view.tsx', 'src/.generated/types.ts', 'src/node_modules/skipped.ts']) writeFileSync(path.join(root, file), '');
    assert.equal(isDynamicPattern('src/**/*.{ts,tsx}'), true);
    assert.equal(isDynamicPattern('src/app.ts'), false);
    assert.deepEqual(globSync('src', { cwd: root, dot: true, ignore: ['**/node_modules/**'] }).sort(), ['src/.generated/types.ts', 'src/app.ts', 'src/view.tsx']);
    assert.deepEqual(globSync(['src/**/*.{ts,tsx}', '!**/node_modules/**'], { cwd: root, expandDirectories: false }).sort(), ['src/app.ts', 'src/view.tsx']);
    assert.deepEqual(globSync('src', { cwd: root, expandDirectories: false }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
