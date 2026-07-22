/**
 * Read the current question via pw-cdp + the same DOM logic pw-quiz-read uses,
 * then look up a matching entry in the plan JSON and pick that option.
 *
 *   node pw-quiz-answer-from-plan.js [--plan data/prep/attempt3-plan.json]
 *
 * Exits 0 on success. Exits non-zero if plan can't be matched.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { connectOverCdp } = require('./pw-cdp.js');
const { currentAttemptId, attemptDir } = require('./quiz-log.js');
const { dataPath } = require('./lib/paths');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function readCurrent() {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'pw-quiz-read.js')], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || 'pw-quiz-read failed');
  const jsonStart = res.stdout.indexOf('{');
  return JSON.parse(res.stdout.slice(jsonStart));
}

async function main() {
  const planPath = arg('--plan') || dataPath('prep', 'attempt3-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const q = readCurrent();
  if (q.mode !== 'question') {
    console.log(JSON.stringify({ ok: false, reason: 'not-a-question', mode: q.mode }));
    process.exit(3);
  }

  const stemN = normalize(q.stem);
  const entry = plan.answers.find((a) => stemN.includes(normalize(a.stemHint)));
  if (!entry) {
    console.log(JSON.stringify({ ok: false, reason: 'no-plan-match', qNum: q.qNum, stem: q.stem }));
    process.exit(4);
  }

  const pickN = normalize(entry.pick);
  const optExact = q.options.find((o) => normalize(o) === pickN);
  const optSub = optExact || q.options.find((o) => normalize(o).includes(pickN) || pickN.includes(normalize(o)));
  if (!optSub) {
    console.log(JSON.stringify({ ok: false, reason: 'option-not-found', pick: entry.pick, options: q.options }));
    process.exit(5);
  }

  const { browser, page } = await connectOverCdp();
  try {
    const clicked = await page.evaluate((wanted) => {
      function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
      const wantN = norm(wanted);
      const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
      for (const inp of inputs) {
        const wrap = inp.closest('label, li, div');
        const txt = (wrap ? wrap.innerText : inp.parentElement?.innerText || '').trim().replace(/\s+/g, ' ');
        if (norm(txt) === wantN || norm(txt).includes(wantN) || wantN.includes(norm(txt))) {
          const label = inp.closest('label') || wrap || inp;
          try { label.click(); } catch {}
          try { inp.click(); } catch {}
          return { ok: true, matched: txt };
        }
      }
      return { ok: false };
    }, optSub);

    if (!clicked.ok) {
      console.log(JSON.stringify({ ok: false, reason: 'dom-click-failed', pick: entry.pick }));
      process.exit(6);
    }

    await sleep(400);

    const attemptId = currentAttemptId();
    if (attemptId) {
      const p = path.join(attemptDir(attemptId), 'answers.jsonl');
      const record = {
        attemptId,
        qNum: q.qNum,
        stem: q.stem,
        options: q.options,
        picks: [optSub],
        confidence: 'high',
        reasoning: entry.reason,
        loggedAt: new Date().toISOString(),
      };
      fs.appendFileSync(p, JSON.stringify(record) + '\n');
    }

    console.log(JSON.stringify({ ok: true, qNum: q.qNum, pick: optSub, matched: clicked.matched, reason: entry.reason }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
