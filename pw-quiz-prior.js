/**
 * Show every prior attempt's picks + confidence for a given stem, so I can
 * decide whether to reuse the previous answer or rotate to an untried option
 * when I see the same question on a retake.
 *
 *   node pw-quiz-prior.js "stem text or substring"
 *
 * If no argument is given, returns priors for the *current* question on screen.
 */
const { connectOverCdp } = require('./pw-cdp.js');
const { loadHistory, normalizeStemKey } = require('./quiz-log.js');

async function currentStem() {
  const { browser, page } = await connectOverCdp();
  try {
    return await page.evaluate(() => {
      const candidates = [
        '.question-text',
        '.question-stem',
        '[class*="question"] p',
        '[class*="Question"] p',
        '.qti-prompt',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 10) return el.innerText.trim();
      }
      const t = document.body?.innerText || '';
      const m = t.match(/Fields marked[^\n]*\n([\s\S]*?)\n\s*Question\s+\d+/i);
      return m ? m[1].split(/\n+/).slice(0, 3).join(' ').trim() : '';
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const explicit = process.argv.slice(2).join(' ').trim();
  const stem = explicit || (await currentStem());
  if (!stem) {
    console.log(JSON.stringify({ ok: false, reason: 'no-stem' }));
    process.exit(2);
  }

  const hist = loadHistory();
  const key = normalizeStemKey(stem);
  const exact = hist.stems[key];
  let matches = exact ? [exact] : [];
  if (!exact) {
    matches = Object.values(hist.stems)
      .filter((e) => e.stemKey.includes(key) || key.includes(e.stemKey))
      .slice(0, 3);
  }

  const summary = matches.map((entry) => ({
    stemKey: entry.stemKey,
    stemSamples: entry.stemSamples.slice(0, 2),
    allOptions: entry.allOptions,
    picks: entry.picks.map((p) => ({
      attemptId: p.attemptId,
      qNum: p.qNum,
      picks: p.picks,
      confidence: p.confidence,
      attemptScore: p.attemptScore,
      attemptPass: p.attemptPass,
      reasoning: (p.reasoning || '').slice(0, 200),
    })),
  }));

  console.log(JSON.stringify({ ok: true, stem, key, matches: summary }, null, 2));
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
