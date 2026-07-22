/**
 * Fit the viewport of a specified tab to match its browser window inner size,
 * clearing any prior device-metrics override.
 *
 *   node pw-fit-tab.js [tabIdx=0]
 *
 * Useful when there are multiple tabs and you want to size a particular one.
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

    const { innerW, innerH, dpr } = await page.evaluate(() => ({
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }));
    const w = Math.max(320, Math.floor(innerW));
    const h = Math.max(200, Math.floor(innerH));

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    try {
      await page.setViewportSize({ width: w, height: h });
    } catch {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: dpr,
        mobile: false,
      });
    }

    console.log(JSON.stringify({ ok: true, tab: idx, width: w, height: h, dpr, url: page.url() }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
