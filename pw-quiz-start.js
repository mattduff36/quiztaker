/**
 * Click START on the Saba welcome screen to begin the timed test.
 * Also creates a fresh attempt folder under data/runs/<attemptId>/ and points
 * data/runs/current-attempt.txt at it so other scripts log into the right place.
 *
 *   node pw-quiz-start.js [--note "text"]
 */
const { connectOverCdp } = require('./pw-cdp.js');
const { startAttempt } = require('./quiz-log.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const note = arg('--note') || '';

  const { browser, page } = await connectOverCdp();
  try {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => /^\s*START\s*$/i.test(b.innerText || '') && !b.hidden && b.offsetParent !== null,
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.log(JSON.stringify({ ok: false, reason: 'no-start-button' }));
      process.exit(4);
    }

    await sleep(2500);

    const state = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const m = t.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
      return { hasQuestion: !!m, qNum: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null };
    });

    const attemptId = startAttempt(note);
    console.log(JSON.stringify({ ok: true, attemptId, ...state }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
