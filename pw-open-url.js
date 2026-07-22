// pw-open-url.js
//
// Opens a URL in a new tab of the attached CDP browser (does not disturb any
// existing tabs). Used by the dashboard's "re-launch a previous URL" control.
//
//   node pw-open-url.js "https://example.com/..."
//
// Prints a small JSON status.

const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const url = process.argv[2];

async function main() {
  if (!url || !/^https?:\/\//i.test(url)) {
    console.log(JSON.stringify({ ok: false, error: 'a http(s) URL argument is required' }));
    process.exit(0);
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: 'not-connected', error: e.message }));
    return;
  }
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.bringToFront().catch(() => {});
    console.log(JSON.stringify({ ok: true, url, title: await page.title().catch(() => '') }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  } finally {
    // Detach without closing the browser.
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  process.exit(0);
});
