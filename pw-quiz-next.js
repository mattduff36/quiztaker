/**
 * Advance to the next question on the Saba quiz player.
 *
 *   node pw-quiz-next.js [--expect <N>]
 *
 * Clicks the visible button.next-btn (ignoring the hidden duplicate) and verifies
 * the page moved to the next question. If --expect is provided the script exits
 * non-zero unless the new qNum matches. This is how we prevent the Q1 -> Q3
 * "double advance" bug that blew up a previous attempt.
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

async function readMode(page) {
  return page.evaluate(() => {
    const t = document.body?.innerText || '';
    if (/Thank you for taking the test|Test score|Test result/i.test(t)) return 'result';
    if (/You have reached the end of the test|Unanswered Questions/i.test(t)) return 'end';
    if (/Question\s+\d+\s+of\s+\d+/.test(t)) return 'question';
    return 'unknown';
  });
}

async function main() {
  const expect = arg('--expect');
  const expectNum = expect == null ? null : Number(expect);

  const { browser, page } = await connectOverCdp();
  try {
    const before = await readQNum(page);
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button.next-btn, button[aria-label="Go to next question"]')].find(
        (b) => !b.hidden && b.getAttribute('aria-hidden') !== 'true' && b.offsetParent !== null,
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.log(JSON.stringify({ ok: false, reason: 'no-visible-next-button', before }));
      process.exit(4);
    }

    let after = before;
    let mode = 'question';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(300);
      mode = await readMode(page);
      if (mode === 'result' || mode === 'end') break;
      after = await readQNum(page);
      if (after != null && after !== before) break;
    }

    const result = { ok: true, before, after, mode };
    if (expectNum != null) {
      result.expected = expectNum;
      result.ok = after === expectNum || mode === 'result' || mode === 'end';
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
