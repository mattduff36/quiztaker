/**
 * Inspect a specific browser tab: capture screenshot, dump readable text,
 * and (for SCORM/iframe pages) recursively pull text from every same-origin
 * iframe frame so we can see slide content behind a Content Player wrapper.
 *
 *   node pw-tab-inspect.js <tabIdx> [outNameNoExt]
 *
 * Writes to data/prep/<outNameNoExt>.png + .txt (defaults to `tab<idx>`).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function pickPage(browser, idx) {
  const contexts = browser.contexts();
  const pages = [];
  for (const c of contexts) for (const p of c.pages()) pages.push(p);
  if (idx < 0 || idx >= pages.length) {
    throw new Error(`tab ${idx} out of range (have ${pages.length})`);
  }
  return pages[idx];
}

async function dumpFrames(page) {
  const chunks = [];
  const frames = page.frames();
  for (const f of frames) {
    let txt = '';
    try {
      txt = await f.evaluate(() => document.body?.innerText || '');
    } catch {
      txt = '';
    }
    if (txt && txt.trim().length > 0) {
      chunks.push(`\n=== FRAME url=${f.url()} name=${f.name() || '(main)'} ===\n${txt}`);
    }
  }
  return chunks.join('\n');
}

async function main() {
  const tabIdx = Number(process.argv[2]);
  if (!Number.isFinite(tabIdx)) {
    console.error('Usage: node pw-tab-inspect.js <tabIdx> [outNameNoExt]');
    process.exit(2);
  }
  const outName = process.argv[3] || `tab${tabIdx}`;

  const outDir = path.join(process.cwd(), 'data', 'prep');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = path.join(outDir, `${outName}.png`);
  const txt = path.join(outDir, `${outName}.txt`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const page = await pickPage(browser, tabIdx);
    try {
      await page.bringToFront();
    } catch {}
    try {
      await page.screenshot({ path: shot, fullPage: false });
    } catch (e) {
      // ignore
    }
    const text = await dumpFrames(page);
    fs.writeFileSync(txt, text, 'utf8');
    console.log(JSON.stringify({ ok: true, url: page.url(), title: await page.title().catch(() => ''), screenshot: shot, text: txt, bytes: text.length }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
