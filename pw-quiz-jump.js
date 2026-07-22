/**
 * Jump to a specific question via the QUESTION LIST.
 *
 *   node pw-quiz-jump.js <qNum>
 *
 * Opens QUESTION LIST (if not already open), finds the list row for the
 * requested question number, clicks it, and returns the new qNum.
 */
const { connectOverCdp } = require('./pw-cdp.js');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const target = Number(process.argv[2]);
  if (!Number.isFinite(target) || target < 1 || target > 60) {
    console.error('Usage: node pw-quiz-jump.js <qNum 1..60>');
    process.exit(2);
  }

  const { browser, page } = await connectOverCdp();
  try {
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, a, [role="button"], span')].find((el) =>
        /^\s*QUESTION LIST\s*$/i.test((el.innerText || el.textContent || '').trim()),
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (opened) await sleep(1000);

    const clicked = await page.evaluate((target) => {
      const prefix = new RegExp(`^\\s*${target}\\b`);
      const nodes = [...document.querySelectorAll('li, div, span, button')];
      const candidates = nodes.filter((el) => {
        const txt = (el.innerText || el.textContent || '').trim();
        return prefix.test(txt) && txt.length < 400;
      });
      const chosen = candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (chosen) {
        chosen.click();
        return true;
      }
      return false;
    }, target);

    if (!clicked) {
      console.log(JSON.stringify({ ok: false, reason: 'no-match', target }));
      process.exit(4);
    }

    await sleep(1400);
    const after = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const m = t.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
      return m ? Number(m[1]) : null;
    });
    console.log(JSON.stringify({ ok: after === target, target, after }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
