// pw-close-browser.js
//
// Closes the CDP browser we attached to. Uses the CDP `Browser.close` command,
// which actually terminates Chrome (unlike browser.close() over a CDP
// connection, which only detaches). Falls back to closing every context/page
// if the command isn't available.
//
//   node pw-close-browser.js
//
// Prints a small JSON status so the dashboard can report success.

const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: 'not-connected', error: e.message }));
    return;
  }

  // Preferred: ask Chrome itself to shut down via the DevTools protocol.
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
    console.log(JSON.stringify({ ok: true, method: 'Browser.close' }));
    return;
  } catch (e) {
    // Fall back to closing contexts/pages, then detaching.
    try {
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) { await page.close().catch(() => {}); }
        await ctx.close().catch(() => {});
      }
      await browser.close().catch(() => {});
      console.log(JSON.stringify({ ok: true, method: 'contexts', note: e.message }));
    } catch (e2) {
      console.log(JSON.stringify({ ok: false, error: e2.message }));
    }
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  process.exit(0);
});
