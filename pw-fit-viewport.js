/**
 * Match the CDP tab's layout viewport to the current browser window inner size,
 * then clear any device-metrics override so the page lays out naturally.
 *
 *   node pw-fit-viewport.js
 */
const { connectOverCdp } = require('./pw-cdp.js');

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
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

    console.log(JSON.stringify({ ok: true, width: w, height: h, dpr, url: page.url() }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
