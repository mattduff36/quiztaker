/**
 * Record my answer for the current question (after pw-quiz-pick has selected it).
 * This is a separate step from clicking so the log stays accurate even if the
 * Saba click races with something on the page.
 *
 *   node pw-quiz-log-answer.js \
 *       --qNum 1 \
 *       --stem "Question text..." \
 *       --options '["A","B","C","D"]' \
 *       --picks '["B"]' \
 *       --confidence high \
 *       --reasoning "Cited HPE QuickSpecs foo, corroborated with Intel brief..."
 *
 * Either --options / --picks must be JSON arrays, or omit them and the script
 * will read the current DOM state.
 *
 * Logs to data/runs/<currentAttempt>/answers.jsonl via quiz-log.js.
 */
const { connectOverCdp } = require('./pw-cdp.js');
const { appendAnswer, currentAttemptId } = require('./quiz-log.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function parseJsonArr(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [raw];
  }
}

async function main() {
  const attemptId = currentAttemptId();
  if (!attemptId) {
    console.error('No active attempt. Run pw-quiz-start.js first.');
    process.exit(2);
  }

  const qNumArg = arg('--qNum');
  const stemArg = arg('--stem');
  const optionsArg = arg('--options');
  const picksArg = arg('--picks');
  const confidence = (arg('--confidence') || 'med').toLowerCase();
  const reasoning = arg('--reasoning') || '';

  const { browser, page } = await connectOverCdp();
  try {
    const live = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const m = t.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
      const rows = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')]
        .filter((el) => el.offsetParent !== null || el.checked)
        .map((el) => {
          const label =
            (el.labels && el.labels[0] && el.labels[0].innerText) ||
            el.closest('label')?.innerText ||
            el.nextElementSibling?.innerText ||
            '';
          return { label: label.trim().replace(/\s+/g, ' '), checked: el.checked };
        });
      return {
        qNum: m ? Number(m[1]) : null,
        options: rows.map((r) => r.label).filter(Boolean),
        picks: rows.filter((r) => r.checked).map((r) => r.label),
      };
    });

    const qNum = qNumArg != null ? Number(qNumArg) : live.qNum;
    const options = parseJsonArr(optionsArg) || live.options;
    const picks = parseJsonArr(picksArg) || live.picks;

    const row = appendAnswer(attemptId, {
      attemptId,
      qNum,
      stem: stemArg || '',
      options,
      picks,
      confidence,
      reasoning,
    });
    console.log(JSON.stringify({ ok: true, attemptId, logged: row }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
