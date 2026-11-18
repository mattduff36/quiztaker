/**
 * List all open tabs across every browser context connected via CDP.
 *
 *   node pw-list-tabs.js
 *
 * Prints index, title, url, contextIdx, focus state and live CDP target identity.
 */
const { chromium } = require('playwright');
const { listBrowserTabs } = require('./lib/browser-tabs');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const tabs = await listBrowserTabs(browser);
    console.log(JSON.stringify(tabs, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
