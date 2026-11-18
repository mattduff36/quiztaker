const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readSnapshot, sameLearnerView, revalidateLearnerDecision, applyAction } = require('./pw-learn-quiz');

const slide = `<div id="slide-label">slide: Course overview</div>
  <div class="slide-layer base-layer shown" data-model-id="slide1">
    <p id="animated">A stable explanation that animates into view.</p>
  </div>
  <span class="acc-text" data-represents="slide1.description">A stable explanation that animates into view.</span>
  <span id="play-label" class="acc-text" data-represents="player.play">Pause</span>
  <button id="play" class="acc-shadow-el" data-represents="player.play">Pause</button>
  <button id="next" class="acc-shadow-el" data-represents="player.next" onclick="window.advanced=true">Next</button>`;

test('animation-only visibility/control churn accepts the same semantic Next and remaps its observed id', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(slide);
    const before = await readSnapshot(page);
    const next = before.snapshot.buttons.find(button => button.name === 'Next');
    let after, rechecks = 0, legacyRechecks = 0;
    for (let frame = 0; frame < 7; frame++) {
      await page.evaluate(frame => {
        document.getElementById('animated').style.opacity = frame % 2 ? '1' : '0';
        document.getElementById('play').style.display = frame % 2 ? 'block' : 'none';
        document.getElementById('play').textContent = frame % 2 ? 'Play' : 'Pause';
        document.getElementById('play-label').textContent = frame % 2 ? 'Play' : 'Pause';
      }, frame);
      after = await readSnapshot(page);
      legacyRechecks += !sameLearnerView(before.snapshot, after.snapshot);
      rechecks += !revalidateLearnerDecision(before.snapshot, after.snapshot, { action: 'click', targetId: next.id }).ok;
    }
    assert.equal(legacyRechecks, 7);
    assert.equal(rechecks, 0);
    assert.equal(sameLearnerView(before.snapshot, after.snapshot), false);
    const result = revalidateLearnerDecision(before.snapshot, after.snapshot, { action: 'click', targetId: next.id });
    assert.equal(result.ok, true);
    assert.notEqual(result.action.targetId, next.id);
    assert.equal(JSON.stringify(after.snapshot).includes('navigationView'), false);
    await applyAction(page, result.action, after.snapshot, after.handles);
    assert.equal(await page.evaluate(() => window.advanced), true);
    assert.equal(revalidateLearnerDecision(before.snapshot, after.snapshot, { action: 'capture' }).ok, false);
  } finally { await browser.close(); }
});

test('changed slide, stem, question, choice, selection, target or modal still invalidates navigation', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    for (const mutation of [
      () => document.getElementById('slide-label').textContent = 'slide: Another slide',
      () => document.getElementById('animated').textContent = 'A changed question stem',
      () => document.querySelector('.acc-text').textContent = 'A different meaning',
      () => document.getElementById('next').setAttribute('data-represents', 'another.next'),
      () => document.body.insertAdjacentHTML('beforeend', '<div role="dialog">A new prompt</div>'),
      () => document.body.insertAdjacentHTML('beforeend', '<p>Question 1 of 2</p><label><input type="radio">Choice A</label>'),
    ]) {
      await page.setContent(slide);
      const before = await readSnapshot(page, 'quiz');
      const next = before.snapshot.buttons.find(button => button.name === 'Next');
      await page.evaluate(mutation);
      const after = await readSnapshot(page, 'quiz');
      assert.equal(revalidateLearnerDecision(before.snapshot, after.snapshot, { action: 'click', targetId: next.id }).ok, false, mutation.toString());
    }
    for (const mutation of [
      () => document.getElementById('choice').checked = true,
      () => document.querySelector('label').lastChild.textContent = 'Changed choice',
      () => document.querySelector('#question').textContent = 'Question 2 of 2: A changed stem',
    ]) {
      await page.setContent(`${slide}<p id="question">Question 1 of 2: Pick an option</p><label><input id="choice" type="radio">Choice A</label>`);
      const before = await readSnapshot(page, 'quiz');
      const next = before.snapshot.buttons.find(button => button.name === 'Next');
      await page.evaluate(mutation);
      const after = await readSnapshot(page, 'quiz');
      assert.equal(revalidateLearnerDecision(before.snapshot, after.snapshot, { action: 'click', targetId: next.id }).ok, false, mutation.toString());
    }
  } finally { await browser.close(); }
});
