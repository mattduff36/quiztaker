#!/usr/bin/env node
// pw-course-fast-complete.js
//
// Fastest possible SCORM 1.2 course completion:
//   1. Reach into the Content Player tab (default: page 1) and locate the `sco` frame
//   2. Read current lesson_status/score
//   3. Set cmi.core.lesson_status = "passed", cmi.core.score.raw = 100, min=0, max=100
//   4. LMSCommit
//   5. Optionally LMSFinish and close the tab
//
// Usage:
//   node pw-course-fast-complete.js [tabIndex] [--status=completed|passed] [--score=100]
//                                   [--no-close] [--label=courseNameForLog]
//
// The Content Player tab must have already progressed past the intro splash
// (i.e. the `sco` frame must expose oLMS_API and fSetLessonStatus). If it's
// still on the intro, this script will click "Launch course" first.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { tabIndex: null, status: 'passed', score: 100, close: true, label: '' };
  for (const a of argv) {
    if (/^--status=/.test(a)) args.status = a.split('=')[1];
    else if (/^--score=/.test(a)) args.score = Number(a.split('=')[1]);
    else if (a === '--no-close') args.close = false;
    else if (/^--label=/.test(a)) args.label = a.split('=')[1];
    else if (/^\d+$/.test(a)) args.tabIndex = Number(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const pages = ctx.pages();

  // Auto-detect: if not given, pick the tab whose URL matches content-na2prd (SCORM host)
  let idx = args.tabIndex;
  if (idx == null) {
    for (let i = 0; i < pages.length; i++) {
      if (/content-na2prd|remote_frameset|content-player/i.test(pages[i].url())) { idx = i; break; }
    }
  }
  if (idx == null) throw new Error('Could not find a Content Player tab');
  const page = pages[idx];

  console.log(JSON.stringify({ tab: idx, url: page.url().slice(0, 90) }));

  // Step 1: launch the course if still on splash
  const launched = await page.evaluate(() => {
    function find(win, name) {
      if (win.name === name) return win;
      for (let i = 0; i < win.frames.length; i++) {
        try { const f = find(win.frames[i], name); if (f) return f; } catch(e) {}
      }
      return null;
    }
    const sco = find(window, 'sco');
    if (!sco) return 'no-sco';
    if (sco.fSetLessonStatus || sco.oLMS_API) return 'ready';
    const btn = [...sco.document.querySelectorAll('a, button')]
      .find(el => /^\s*Launch\s*course\s*$/i.test((el.innerText || el.textContent || '').trim()));
    if (btn) { btn.click(); return 'clicked-launch'; }
    return 'no-launch-btn';
  });
  console.log('launch:', launched);
  if (launched === 'clicked-launch') await new Promise(r => setTimeout(r, 3500));

  // Step 2 + 3 + 4: read + set + commit
  const result = await page.evaluate(async ({ status, score }) => {
    function find(win, name) {
      if (win.name === name) return win;
      for (let i = 0; i < win.frames.length; i++) {
        try { const f = find(win.frames[i], name); if (f) return f; } catch(e) {}
      }
      return null;
    }
    const sco = find(window, 'sco');
    if (!sco) return { err: 'no-sco' };
    const api = sco.oLMS_API || sco.API;
    if (!api) return { err: 'no-api' };

    const before = {
      lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
      score_raw: api.LMSGetValue('cmi.core.score.raw'),
      entry: api.LMSGetValue('cmi.core.entry')
    };

    const setResults = {};
    setResults.status = api.LMSSetValue('cmi.core.lesson_status', status);
    setResults.score_raw = api.LMSSetValue('cmi.core.score.raw', String(score));
    setResults.score_min = api.LMSSetValue('cmi.core.score.min', '0');
    setResults.score_max = api.LMSSetValue('cmi.core.score.max', '100');
    // Include a plausible session_time (10 min)
    try { setResults.session_time = api.LMSSetValue('cmi.core.session_time', '00:10:00'); } catch (e) {}
    setResults.commit = api.LMSCommit('');

    const after = {
      lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
      score_raw: api.LMSGetValue('cmi.core.score.raw')
    };

    return { before, setResults, after };
  }, { status: args.status, score: args.score });

  console.log('scorm:', JSON.stringify(result, null, 2));

  // Step 5: optionally LMSFinish + close
  if (args.close) {
    await page.evaluate(async () => {
      function find(win, name) {
        if (win.name === name) return win;
        for (let i = 0; i < win.frames.length; i++) {
          try { const f = find(win.frames[i], name); if (f) return f; } catch(e) {}
        }
        return null;
      }
      const sco = find(window, 'sco');
      const api = sco?.oLMS_API || sco?.API;
      if (api) {
        try { api.LMSFinish(''); } catch (e) {}
      }
    });
    // Give any auto-close SCORM finish handlers time to fire
    await new Promise(r => setTimeout(r, 1500));
    // Handle any confirm/alert dialog Saba might raise
    page.once('dialog', async d => { try { await d.accept(); } catch (e) {} });
    try { await page.close({ runBeforeUnload: true }); } catch (e) { console.log('close-err:', e.message); }
    await new Promise(r => setTimeout(r, 1000));
    console.log('tab closed');
  }

  // Log to history
  const histDir = path.join('data', 'course-history');
  fs.mkdirSync(histDir, { recursive: true });
  const rec = {
    ts: new Date().toISOString(),
    label: args.label,
    tab: idx,
    strategy: 'fast-scorm',
    status_set: args.status,
    score_set: args.score,
    result
  };
  fs.appendFileSync(path.join(histDir, 'log.jsonl'), JSON.stringify(rec) + '\n');

  await b.close();
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
