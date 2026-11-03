const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { observePlayerEvidence } = require('./lib/player-evidence');
const { readSnapshot } = require('./pw-learn-quiz');

test('player markers cross readable frames without exposing URLs, content or exact versions', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe></iframe><iframe style="display:none"></iframe>');
    await page.frames()[1].setContent('<div class="dki-authoring-element disableClaroPadding"><div class="dki-element-content flipCardPanel">Private course words</div></div>');
    await page.frames()[2].setContent('<div class="rise-app"></div>');
    const evidence = await observePlayerEvidence(page);
    assert.equal(evidence, '[Player DOM evidence: dki-claro-padding,dki-elements,dki-flip-card]');
    assert.doesNotMatch(evidence, /Private|http|rise|version/i);
    const snapshot = (await readSnapshot(page)).snapshot;
    assert.ok(snapshot.text.startsWith(evidence));
    assert.ok(snapshot.text.length <= 8000);
    await page.setContent('<h1>Unknown player</h1>');
    assert.equal(await observePlayerEvidence(page), '[Player DOM evidence: unrecognized]');
  } finally { await browser.close(); }
});
