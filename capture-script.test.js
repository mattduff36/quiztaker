const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('packaged capture writes metadata and resolves its separate data directory', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vitriol-capture-test-'));
  const appRoot = path.join(fixture, 'installed', 'automation');
  const dataRoot = path.join(fixture, 'user-data', 'data');
  const messages = [];
  let closed = false;
  const page = {
    title: async () => 'Fixture course', url: () => 'https://example.invalid/course',
    screenshot: async ({ path: file }) => fs.writeFileSync(file, 'fixture image'),
    evaluate: async () => ({ visibleText: 'Fixture content', htmlPreview: '<p>Fixture content</p>', buttons: [], frames: [] }),
  };
  const browser = { contexts: () => [{ pages: () => [page] }], close: async () => { closed = true; } };
  try {
    await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pw-learn-capture.js'), 'utf8'), {
      require: (name) => {
        if (name === 'playwright') return { chromium: { connectOverCDP: async () => browser } };
        if (name === './lib/paths') return { APP_ROOT: appRoot, dataPath: (...parts) => path.join(dataRoot, ...parts) };
        if (name === './lib/page-probe') return { probePage: async () => ({ fingerprint: 'fixture', urlKind: 'unknown' }) };
        if (name === './lib/learning-engine') return { queueReview: () => {}, suggestNextAction: () => ({ detail: 'Review fixture' }) };
        return require(name);
      },
      process: { argv: ['node', 'pw-learn-capture.js', '0'], env: {}, exit: () => { throw new Error(messages.join('\n')); } },
      console: { log: (value) => messages.push(value), error: (value) => messages.push(value) },
    });
    const result = JSON.parse(messages.at(-1));
    assert.equal(result.ok, true);
    assert.equal(closed, true);
    const directory = path.resolve(appRoot, result.dir);
    assert.ok(directory.startsWith(dataRoot + path.sep));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8')).fingerprint, 'fixture');
    assert.equal(fs.readFileSync(path.join(directory, 'visible-text.txt'), 'utf8'), 'Fixture content');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
