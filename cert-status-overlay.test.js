const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { overlayShouldClose, readCourseList } = require('./lib/cert-status');

test('closes the congratulations evaluation dialog and not a bare page', () => {
  const text = 'Congratulations! You have completed the course. Do you want to evaluate the course now?';
  assert.equal(overlayShouldClose(text, ['CLOSE', 'EVALUATE']), true);
  assert.equal(overlayShouldClose('Evaluate this course?', ['Close', 'Not now']), true);
  assert.equal(overlayShouldClose('Leave your Rating & Comments', ['Print']), false);
  assert.equal(overlayShouldClose(text, ['EVALUATE btn-primary', 'CLOSE btn']), true);
  assert.equal(overlayShouldClose(text, ['EVALUATE']), false);
});

test('certification roster never offers disabled actions, with or without prerequisite text', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="module-wrapper"><p>In Progress</p><button title="Launch Enabled">LAUNCH</button></div>
      <div class="module-wrapper"><p>In Progress</p><button title="Launch Native" disabled>LAUNCH</button></div>
      <div class="module-wrapper"><p>In Progress</p><button title="Launch Aria" aria-disabled="true">LAUNCH</button></div>
      <div class="module-wrapper"><p>In Progress</p><trq-splitbutton aria-disabled="true"><button title="Launch Wrapper" aria-disabled="false">LAUNCH</button></trq-splitbutton></div>
      <div class="module-wrapper"><p>In Progress</p><trq-splitbutton class="trq-aria-disabled"><button title="Launch MenuOnly">LAUNCH</button></trq-splitbutton></div>
      <div class="module-wrapper"><p>In Progress</p><fieldset disabled><button title="Launch Fieldset">LAUNCH</button></fieldset></div>
      <div class="module-wrapper"><p>In Progress</p><p>This certification requires you to follow a predefined learning sequence. Actions become available after the previous module in the sequence.</p><trq-splitbutton class="trq-aria-disabled"><button title="View Sequence">VIEW</button></trq-splitbutton></div>
      <div class="module-wrapper"><p>In Progress</p><button title="View COURSE Nested">VIEW</button></div>
    `);
    const rows = await readCourseList(page);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.filter(row => !row.isBlocked).map(row => row.title), ['Enabled', 'MenuOnly']);
    for (const title of ['Native', 'Aria', 'Wrapper', 'Fieldset']) {
      const row = rows.find(row => row.title === title);
      assert.equal(row.isActionDisabled, true, title);
      assert.equal(row.isBlocked, true, title);
      assert.equal(row.blockedReason, 'action-disabled', title);
      assert.match(row.blockingEvidence.join(' '), /is disabled/);
    }
    assert.equal(rows.find(row => row.title === 'Sequence').blockedReason, 'prerequisites-incomplete');
    assert.equal(rows.find(row => row.title === 'COURSE Nested').blockedReason, 'nested-learning-requirement');
  } finally { await browser.close(); }
});
