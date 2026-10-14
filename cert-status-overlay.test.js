const test = require('node:test');
const assert = require('node:assert/strict');
const { overlayShouldClose } = require('./lib/cert-status');

test('closes the congratulations evaluation dialog and not a bare page', () => {
  const text = 'Congratulations! You have completed the course. Do you want to evaluate the course now?';
  assert.equal(overlayShouldClose(text, ['CLOSE', 'EVALUATE']), true);
  assert.equal(overlayShouldClose('Evaluate this course?', ['Close', 'Not now']), true);
  assert.equal(overlayShouldClose('Leave your Rating & Comments', ['Print']), false);
  assert.equal(overlayShouldClose(text, ['EVALUATE btn-primary', 'CLOSE btn']), true);
  assert.equal(overlayShouldClose(text, ['EVALUATE']), false);
});
