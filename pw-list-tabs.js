/**
 * List all open tabs across every browser context connected via CDP.
 *
 *   node pw-list-tabs.js
 *
 * Prints one JSON entry per tab: index, title, url, contextIdx, focus state.
 */
const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const contexts = browser.contexts();
    const tabs = [];
    let idx = 0;
    for (let c = 0; c < contexts.length; c++) {
      const pages = contexts[c].pages();
      for (const p of pages) {
        let title = '';
        try {
          title = await p.title();
        } catch {}
        const focus = await p.evaluate(() => ({
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
        })).catch(() => ({ hasFocus: false, visibilityState: 'unknown' }));
        tabs.push({ idx: idx++, contextIdx: c, title, url: p.url(), ...focus });
      }
    }
    console.log(JSON.stringify(tabs, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
