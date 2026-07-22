/**
 * Open QUESTION LIST and summarise the current attempt before submit.
 * Also reconciles against the answer log so low-confidence questions are easy
 * to spot for a last-look pass.
 *
 *   node pw-quiz-review.js
 *
 * Output JSON:
 *   {
 *     "answeredCount": 60,
 *     "unanswered": [2, 17],
 *     "lowConfidence": [ { "qNum": 5, "stem": "...", "picks": [...], "confidence": "low" } ]
 *   }
 */
const path = require('path');
const fs = require('fs');
const { connectOverCdp } = require('./pw-cdp.js');
const { currentAttemptId, attemptDir } = require('./quiz-log.js');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const attemptId = currentAttemptId();
  const { browser, page } = await connectOverCdp();
  try {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, a, [role="button"], span')].find((el) =>
        /^\s*QUESTION LIST\s*$/i.test((el.innerText || el.textContent || '').trim()),
      );
      if (btn) btn.click();
    });
    await sleep(1200);

    const listState = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const answeredMatch = t.match(/Answered\s*\(\s*(\d+)\s*\)/i);
      const unansweredMatch = t.match(/Unanswered\s*\(\s*(\d+)\s*\)/i);
      const items = [...document.querySelectorAll('[class*="question-list"] [class*="item"], ul li')]
        .slice(0, 120)
        .map((el) => (el.innerText || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      return {
        answeredCount: answeredMatch ? Number(answeredMatch[1]) : null,
        unansweredCount: unansweredMatch ? Number(unansweredMatch[1]) : null,
        items: items.slice(0, 80),
      };
    });

    let log = [];
    if (attemptId) {
      const p = path.join(attemptDir(attemptId), 'answers.jsonl');
      if (fs.existsSync(p)) {
        log = fs
          .readFileSync(p, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    }

    const lowConfidence = log
      .filter((a) => a.confidence === 'low' || a.confidence === 'med')
      .map((a) => ({
        qNum: a.qNum,
        stem: a.stem,
        picks: a.picks,
        options: a.options,
        confidence: a.confidence,
        reasoning: a.reasoning,
      }))
      .sort((a, b) => (a.qNum ?? 0) - (b.qNum ?? 0));

    const loggedQs = new Set(log.map((a) => a.qNum).filter((n) => Number.isFinite(n)));
    const unanswered = [];
    for (let i = 1; i <= 60; i++) if (!loggedQs.has(i)) unanswered.push(i);

    console.log(
      JSON.stringify(
        {
          attemptId,
          answeredCount: listState.answeredCount,
          unansweredCount: listState.unansweredCount,
          loggedCount: log.length,
          unanswered,
          lowConfidence,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
