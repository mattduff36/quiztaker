/**
 * Solve a slickQuiz-powered Course exam by reading the in-memory quizJSON
 * answer key. Works against the Content Player tab (defaults to the tab whose
 * URL contains "content-na2prd" or falls back to the first tab).
 *
 *   node pw-slickquiz-solve.js [--tab <idx>] [--delay <ms>] [--dry]
 *
 * Flow:
 *   1. Find the content frame + read quizJSON.
 *   2. Click "Begin exam".
 *   3. For each visible .question, tick the option with correct:true, click its Next.
 *   4. Wait for #resultDiv (result) or a score message; print percent + status.
 *   5. Log the picks to data/runs/<attemptId>/slickquiz.jsonl for audit.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { finishExecutor, startExecutor } = require('./lib/executor-ledger');
const { dataPath } = require('./lib/paths');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pickPage(browser, tabArg) {
  const contexts = browser.contexts();
  const pages = [];
  for (const c of contexts) for (const p of c.pages()) pages.push(p);
  if (tabArg != null) {
    const idx = Number(tabArg);
    if (idx < 0 || idx >= pages.length) throw new Error(`tab ${idx} out of range (have ${pages.length})`);
    return pages[idx];
  }
  // Auto-detect: find Content Player
  const cp = pages.find((p) => /content-na2prd|content-player|remote_frameset/i.test(p.url()));
  if (cp) return cp;
  return pages[0];
}

async function main() {
  const tabArg = arg('--tab', null);
  const delay = Number(arg('--delay', '250'));
  const isDryRun = process.argv.includes('--dry');

  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const page = await pickPage(browser, tabArg);
    try { await page.bringToFront(); } catch {}
    const pageTitle = await page.title().catch(() => 'SlickQuiz exam');
    const executor = startExecutor({
      capabilityId: 'slickquiz-solve',
      capabilityVersion: 1,
      script: 'pw-slickquiz-solve.js',
      target: pageTitle,
      risk: isDryRun ? 'none' : 'high',
      actions: isDryRun ? ['probe'] : ['probe', 'answer-select', 'verify', 'exit'],
    });

    // Grab the answer key first
    const preview = await page.evaluate(() => {
      function find(win, name) {
        if (win.name === name) return win;
        for (let i = 0; i < win.frames.length; i++) {
          try { const f = find(win.frames[i], name); if (f) return f; } catch (e) {}
        }
        return null;
      }
      const content = find(window, 'content');
      if (!content) return { ok: false, reason: 'no-content-frame' };
      const qj = content.quizJSON;
      if (!qj || !Array.isArray(qj.questions)) return { ok: false, reason: 'no-quizJSON' };
      const key = qj.questions.map((q, i) => {
        const idx = q.a.findIndex((o) => o.correct === true);
        return { i, stem: q.q, correctIdx: idx, correctText: q.a[idx]?.option };
      });
      return { ok: true, key, count: qj.questions.length };
    });
    if (!preview.ok) throw new Error('cannot read quizJSON: ' + preview.reason);
    console.log(`Loaded ${preview.count} questions from quizJSON.`);
    if (isDryRun) {
      console.log(JSON.stringify({ dryRun: true, questions: preview.count, target: pageTitle }, null, 2));
      finishExecutor(executor, {
        outcome: 'success',
        verified: true,
        status: `dry-run-${preview.count}-questions`,
        targetId: pageTitle,
      });
      return;
    }

    // Log dir
    const runDir = dataPath('runs', 'slickquiz-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'answerkey.json'), JSON.stringify(preview.key, null, 2), 'utf8');
    const log = (obj) => fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(obj) + '\n');

    // Click Begin exam
    const began = await page.evaluate(() => {
      function find(win, name) {
        if (win.name === name) return win;
        for (let i = 0; i < win.frames.length; i++) {
          try { const f = find(win.frames[i], name); if (f) return f; } catch (e) {}
        }
        return null;
      }
      const c = find(window, 'content');
      const btn = c?.document?.querySelector('a.button.startQuiz');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log('startQuiz clicked:', began);
    log({ type: 'startQuiz', clicked: began, ts: new Date().toISOString() });
    await sleep(600);

    // Iterate questions
    for (let i = 0; i < preview.count; i++) {
      const correctIdx = preview.key[i].correctIdx;
      if (correctIdx < 0) {
        console.log(`Q${i + 1}: no correct answer in JSON — skipping click, will click Next.`);
        log({ type: 'question', i, err: 'no-correct-flag' });
      }
      const step = await page.evaluate(({ i, correctIdx }) => {
        function find(win, name) {
          if (win.name === name) return win;
          for (let x = 0; x < win.frames.length; x++) {
            try { const f = find(win.frames[x], name); if (f) return f; } catch (e) {}
          }
          return null;
        }
        const c = find(window, 'content');
        const q = c?.document?.querySelector('#question' + i);
        if (!q) return { ok: false, reason: 'no-question-node' };
        const inputId = 'question' + i + '_' + correctIdx;
        const input = q.querySelector('#' + inputId);
        const label = q.querySelector('label[for="' + inputId + '"]');
        if (input && correctIdx >= 0) {
          try { label?.click(); } catch (e) {}
          try { input.click(); } catch (e) {}
          input.checked = true;
        }
        const nextBtn = q.querySelector('a.nextQuestion, a.button.nextQuestion');
        if (nextBtn) nextBtn.click();
        return { ok: true, clickedInput: inputId, hadNext: !!nextBtn };
      }, { i, correctIdx });
      console.log(`Q${i + 1}: pick=${preview.key[i].correctText?.slice(0, 60)} -> ${JSON.stringify(step)}`);
      log({ type: 'question', i: i + 1, correctIdx, pick: preview.key[i].correctText, step, ts: new Date().toISOString() });
      await sleep(delay);
    }

    // Wait for result and read score
    let result = null;
    for (let t = 0; t < 20; t++) {
      await sleep(400);
      result = await page.evaluate(() => {
        function find(win, name) {
          if (win.name === name) return win;
          for (let x = 0; x < win.frames.length; x++) {
            try { const f = find(win.frames[x], name); if (f) return f; } catch (e) {}
          }
          return null;
        }
        const c = find(window, 'content');
        const resDiv = c?.document?.querySelector('#resultDiv');
        const text = resDiv?.innerText || '';
        const m = text.match(/(\d+)(?=%|\s|$)/);
        return { text, score: m ? Number(m[1]) : null, visible: resDiv?.offsetParent !== null };
      });
      if (result.text && result.text.length > 0) break;
    }

    log({ type: 'result', ...result, ts: new Date().toISOString() });
    console.log('\nResult:', JSON.stringify(result, null, 2));

    // Also inspect the SCORM API to confirm status/score were pushed
    const cmiAfter = await page.evaluate(() => {
      const API = window.API;
      if (!API) return null;
      return {
        lesson_status: API.LMSGetValue('cmi.core.lesson_status'),
        score_raw: API.LMSGetValue('cmi.core.score.raw'),
        session_time: API.LMSGetValue('cmi.core.session_time'),
      };
    });
    log({ type: 'cmiAfter', cmiAfter });
    console.log('\ncmi after exam:', cmiAfter);
    console.log('\nAudit log:', runDir);
    const verified = cmiAfter?.lesson_status === 'passed' || Number(result?.score) >= 80;
    finishExecutor(executor, {
      outcome: verified ? 'success' : 'failure',
      verified,
      status: verified ? `score ${result?.score ?? cmiAfter?.score_raw ?? 'passed'}` : 'quiz-result-unconfirmed',
      failureSignature: verified ? null : 'slickquiz-result-unconfirmed',
      artifacts: [path.relative(process.cwd(), runDir).replace(/\\/g, '/')],
      targetId: pageTitle,
    });
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
