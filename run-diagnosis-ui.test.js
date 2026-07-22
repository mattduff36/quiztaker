const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('dashboard includes the centered run-diagnosis dialog contract', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');

  assert.match(html, /id="run-diagnosis"/);
  assert.match(html, /role="dialog"\s+aria-modal="true"/);
  assert.match(html, /id="run-diagnosis-cause"/);
  assert.match(html, /id="run-diagnosis-targets"/);
  assert.match(html, /id="run-diagnosis-recommendations"/);
  assert.match(client, /if \(diagnosis \|\| summary\.level === 'error'\) openRunDiagnosis/);
  assert.match(css, /\.run-diagnosis\s*\{[^}]*z-index:\s*96/);
  assert.match(css, /\.modal\s*\{[^}]*place-items:\s*center/);
});
