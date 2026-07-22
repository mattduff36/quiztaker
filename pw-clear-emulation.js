/**
 * Clear any device-metrics/viewport emulation override on a tab and then
 * re-report the natural window size.
 *
 *   node pw-clear-emulation.js [tabIdx=0]
 */
const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const idx = Number(process.argv[2] ?? 0);
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const contexts = browser.contexts();
    const pages = [];
    for (const c of contexts) for (const p of c.pages()) pages.push(p);
    if (idx < 0 || idx >= pages.length) {
      throw new Error(`tab ${idx} out of range (have ${pages.length})`);
    }
    const page = pages[idx];
    try {
      await page.bringToFront();
    } catch {}

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await cdp.send('Emulation.resetPageScaleFactor').catch(() => {});
    await cdp.send('Emulation.setEmulatedMedia', { media: '' }).catch(() => {});

    // Force a layout by nudging the window
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const info = await page.evaluate(() => ({
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      screenAvailW: screen.availWidth,
      screenAvailH: screen.availHeight,
      screenW: screen.width,
      screenH: screen.height,
      dpr: window.devicePixelRatio || 1,
      url: location.href,
    }));

    console.log(JSON.stringify({ ok: true, tab: idx, info }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
