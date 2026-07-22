/**
 * Go to the previous question on the Saba quiz player.
 *
 *   node pw-quiz-prev.js [--expect <N>]
 */
const { connectOverCdp } = require('./pw-cdp.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readQNum(page) {
  return page.evaluate(() => {
    const t = (document.body?.innerText || '').match(/Question\s+(\d+)\s+of\s+(\d+)/i);
    return t ? Number(t[1]) : null;
  });
}

async function main() {
  const expect = arg('--expect');
  const expectNum = expect == null ? null : Number(expect);

  const { browser, page } = await connectOverCdp();
  try {
    const before = await readQNum(page);
    const clicked = await page.evaluate(() => {
      const btn = [
        ...document.querySelectorAll(
          'button.prev-btn, button.previous-btn, button[aria-label="Go to previous question"], button[aria-label*="previous" i]',
        ),
      ].find((b) => !b.hidden && b.getAttribute('aria-hidden') !== 'true' && b.offsetParent !== null);
      if (btn) {
        btn.click();
        return true;
      }
      const txtBtn = [...document.querySelectorAll('button, a, [role="button"]')].find(
        (el) => /^\s*PREVIOUS\s*$/i.test((el.innerText || el.textContent || '').trim()) && el.offsetParent !== null,
      );
      if (txtBtn) {
        txtBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.log(JSON.stringify({ ok: false, reason: 'no-visible-prev-button', before }));
      process.exit(4);
    }

    let after = before;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await readQNum(page);
      if (after != null && after !== before) break;
    }

    const result = { ok: true, before, after };
    if (expectNum != null) {
      result.expected = expectNum;
      result.ok = after === expectNum;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(5);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
