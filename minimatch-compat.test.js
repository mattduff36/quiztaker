const test = require('node:test');
const assert = require('node:assert/strict');
const minimatch = require('minimatch');

test('patched matcher supports old callable and modern named APIs', async () => {
  assert.equal(minimatch('src/example.ts', '**/*.ts'), true);
  assert.equal(minimatch('src/example.js', '**/*.ts'), false);
  assert.equal(new minimatch.Minimatch('**/*.{ts,tsx}').match('src/example.tsx'), true);
  assert.equal(minimatch.defaults({ dot: true })('.hidden.ts', '*.ts'), true);
  const named = await import('minimatch');
  assert.equal(named.minimatch('src/example.ts', '**/*.ts'), true);
  assert.deepEqual(minimatch.match(['one.ts', 'two.js'], '*.ts'), ['one.ts']);
});

test('matcher uses the fixed upstream implementation for adversarial glob patterns', () => {
  const metadata = require('minimatch-modern/package.json');
  assert.equal(metadata.version, '11.0.4');
  const matcher = new minimatch.Minimatch('a/**/../**/../**/../b', { optimizationLevel: 2 });
  assert.equal(typeof matcher.match('a/b'), 'boolean');
});
