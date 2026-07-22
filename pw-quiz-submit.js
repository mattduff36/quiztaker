/**
 * Submit the test. Clicks the (often hidden) Submit button, waits for the
 * result screen, parses the score, and finalises the current attempt log.
 *
 *   node pw-quiz-submit.js
 *
 * Will refuse to submit if the current attempt log has <55 answered questions,
 * unless --force is passed. This saves us from the prior failure where the UI
 * "skipped" a question silently and we submitted incomplete.
 */
const fs = require('fs');
const path = require('path');
const { connectOverCdp } = require('./pw-cdp.js');
const { currentAttemptId, attemptDir, finishAttempt } = require('./quiz-log.js');

function arg(name) {
  return process.argv.includes(name);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const force = arg('--force');
  const attemptId = currentAttemptId();
  if (!attemptId) {
    console.error('No active attempt. Run pw-quiz-start.js first.');
    process.exit(2);
  }

  const answersPath = path.join(attemptDir(attemptId), 'answers.jsonl');
  const answered = fs.existsSync(answersPath)
    ? fs.readFileSync(answersPath, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0;

  if (answered < 55 && !force) {
    console.error(`Refusing to submit: only ${answered} questions logged (need 55+). Use --force to override.`);
    process.exit(3);
  }

  const { browser, page } = await connectOverCdp();
  try {
    const clicked = await page.evaluate(() => {
      const direct = document.querySelector('[aria-label="Submit the Test"], [aria-label="Submit Test"]');
      if (direct) {
        direct.click();
        return 'aria-label';
      }
      const btn = [...document.querySelectorAll('button, [role="button"]')].find(
        (b) => /^\s*SUBMIT\s*$/i.test((b.innerText || b.textContent || '').trim()),
      );
      if (btn) {
        btn.click();
        return 'text';
      }
      return null;
    });

    if (!clicked) {
      console.log(JSON.stringify({ ok: false, reason: 'no-submit-button' }));
      process.exit(4);
    }

    // Saba sometimes shows a confirmation modal first.
    await sleep(1500);
    await page.evaluate(() => {
      const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
      if (/unanswered|are you sure|submit the test/i.test(t)) {
        const btn = [...document.querySelectorAll('button, a, [role="button"]')].find(
          (b) =>
            /^\s*(YES|OK|SUBMIT|CONFIRM|CONTINUE)\s*$/i.test((b.innerText || b.textContent || '').trim()) &&
            !b.hidden,
        );
        if (btn) btn.click();
      }
    });

    const deadline = Date.now() + 45000;
    let score = null;
    let pass = null;
    while (Date.now() < deadline) {
      await sleep(1200);
      const state = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        const m = t.match(/Test score\s*([\d.]+)%?/i) || t.match(/Score[:\s]+([\d.]+)%?/i);
        const done = /Thank you for taking the test|Test result|Passed|Failed/i.test(t);
        const passed = /Passed/i.test(t);
        const failed = /Failed/i.test(t);
        return { score: m ? m[1] : null, done, passed, failed, preview: t.slice(0, 800) };
      });
      if (state.score) {
        score = Number(state.score);
        pass = state.passed ? true : state.failed ? false : score >= 80;
        break;
      }
      if (state.done) break;
    }

    const meta = finishAttempt(attemptId, { score, pass });
    console.log(JSON.stringify({ ok: true, attemptId, score, pass, meta }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
