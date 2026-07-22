/**
 * Capture CDP browser state when the expected Saba screen is not shown.
 * Writes PNG + a text snippet under data/ for debugging (options, modals, wrong step).
 *
 * Usage: node pw-screenshot.js
 * Env: SCREENSHOT_PATH (optional override), PLAYWRIGHT_CDP_URL
 */
const fs = require('fs');
const path = require('path');
const { connectOverCdp } = require('./pw-cdp.js');
const { DATA_ROOT } = require('./lib/paths');

async function main() {
  const dir = DATA_ROOT;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const png = path.join(dir, process.env.SCREENSHOT_PATH || `quiz-screenshot-${stamp}.png`);
  const txt = path.join(dir, `quiz-page-text-${stamp}.txt`);

  const { browser, page } = await connectOverCdp();
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(txt, `URL: ${page.url()}\n\n${text}`, 'utf8');
    console.log('screenshot', png);
    console.log('text dump', txt);
    console.log('--- snippet ---\n', text.slice(0, 2500));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
