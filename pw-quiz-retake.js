/**
 * Walk the Saba UI from the post-submit result screen back to the welcome/intro
 * screen so a fresh attempt can be launched with node pw-quiz-start.js.
 *
 * Flow: EXIT -> (confirm YES if asked) -> LAUNCH -> RETAKE.
 * Deliberately stops BEFORE START so pw-quiz-start.js owns creating the new
 * attempt folder and log.
 *
 * If any step is missing (e.g. LAUNCH button not on the current screen), it is
 * skipped - the script is idempotent and safe to re-run.
 */
const { connectOverCdp } = require('./pw-cdp.js');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickByText(page, regex, label) {
  const clicked = await page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const nodes = [...document.querySelectorAll('button, a, [role="button"], span, .mat-button')];
    const el = nodes.find((n) => re.test((n.innerText || n.textContent || '').trim()));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, regex.source);
  if (clicked) console.log(`ok: ${label}`);
  else console.log(`skip: ${label}`);
  if (clicked) await sleep(1800);
  return clicked;
}

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
    await clickByText(page, /^EXIT$/, 'EXIT');
    await clickByText(page, /^YES$/, 'EXIT_CONFIRM_YES');
    await clickByText(page, /^LAUNCH$/, 'LAUNCH');
    await clickByText(page, /^RETAKE$/, 'RETAKE');

    const state = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      return {
        welcome: /Welcome|Number of questions|Passing score/i.test(t) && /START/i.test(t),
        hasStart: !!document.querySelector('button') && /START/i.test(t),
        preview: t.slice(0, 400),
      };
    });
    console.log(JSON.stringify({ ok: true, ...state }, null, 2));
    console.log('\nReady for: node pw-quiz-start.js');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
