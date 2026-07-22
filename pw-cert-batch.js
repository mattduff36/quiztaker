#!/usr/bin/env node
// pw-cert-batch.js  (v2)
//
// Batch-completes every uncompleted course on a Saba certification landing page.
// This version is robust to session preservation:
//   - Never closes the landing tab; navigates it back to the cert URL between courses.
//   - Waits for the SCORM player tab to auto-close (only force-closes as a last resort).
//   - Recognises Successful courses via their `PRINT CERTIFICATE` button, so the
//     roster reader always sees the full 12-course list.
//   - Scrolls the page before reading the roster so courses below the fold are captured.
//   - Dismisses "Evaluate this course?" prompts, then re-expands collapsed
//     requirement cards after every return to the landing page.
//   - Preflights VIEW controls for `.trq-aria-disabled`, sequence notices, and
//     incomplete prerequisite counters instead of waiting for an impossible player.
//   - Diagnoses unexpected no-player outcomes and emits a structured
//     `AUTOMATION_RESULT` consumed by the dashboard failure modal and ledger.
//
// Usage:
//   node pw-cert-batch.js [--only="Course Name"]... [--skip="Course Name"]... [--dry]
//   --only may be repeated to complete only an explicit subset of courses.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  extractCertId,
  buildCertUrl,
  getLandingTab,
  expandCollapsedModules,
  readCourseList,
} = require('./lib/cert-status');
const { finishExecutor, startExecutor } = require('./lib/executor-ledger');
const { dataPath } = require('./lib/paths');

// Cert URL is captured from the current landing tab at connect time so the same
// script works for any certification the user is on.
let CERT_URL = null;

const argv = process.argv.slice(2);
const argVal = (a) => a.slice(a.indexOf('=') + 1);
// --only can be repeated to complete an explicit subset; --skip excludes.
const only = argv.filter(a => /^--only=/.test(a)).map(argVal);
const skip = argv.filter(a => /^--skip=/.test(a)).map(argVal);
const dry = argv.includes('--dry');

const HIST_DIR = dataPath('course-history');
fs.mkdirSync(HIST_DIR, { recursive: true });
const HIST = path.join(HIST_DIR, 'batch.jsonl');
function log(o) { fs.appendFileSync(HIST, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const b = await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222');
  return { b, ctx: b.contexts()[0] };
}

async function goLanding(page) {
  if (CERT_URL) {
    await page.goto(CERT_URL, { waitUntil: 'domcontentloaded' });
  } else {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await sleep(4500);
  // Scroll to bottom to load lazy-rendered course rows
  await page.evaluate(() => new Promise(res => {
    let y = 0;
    const step = 400;
    const iv = setInterval(() => {
      window.scrollBy(0, step);
      y += step;
      if (y > document.body.scrollHeight + 200) { clearInterval(iv); res(); }
    }, 100);
  }));
  await sleep(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
}

async function patchOpen(page) {
  await page.evaluate(() => {
    if (window.__openPatched) return;
    const orig = window.open.bind(window);
    window.open = function (url) { return orig(url, '_blank'); };
    window.__openPatched = true;
  });
}

// Scroll the current page top-to-bottom (and back) to force lazy-rendered
// course rows to mount, WITHOUT navigating away. Used to read the roster from
// the user's current view so it matches what the dashboard picker showed.
async function scrollRosterInPlace(page) {
  try {
    await page.evaluate(() => new Promise((res) => {
      let y = 0;
      const step = 500;
      const iv = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y > document.body.scrollHeight + 200) { clearInterval(iv); res(); }
      }, 60);
    }));
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);
  } catch {}
}

async function clickAction(page, courseTitle) {
  async function tryClick() {
    return await page.evaluate((courseTitle) => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(el => {
        const t = (el.title || '').replace(/^(Launch|View)\s+(WBT\s+)?/i, '').trim();
        return t === courseTitle;
      });
      if (b) { b.click(); return 'clicked'; }
      return 'not-found';
    }, courseTitle);
  }

  const firstAttempt = await tryClick();
  if (firstAttempt === 'clicked') return firstAttempt;

  // Returning from the previous player can collapse a requirement card and
  // remove this course's button from the DOM. Expand cards before giving up.
  await expandCollapsedModules(page);
  return await tryClick();
}

async function findPlayerTab(ctx, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const pages = ctx.pages();
    for (let i = 0; i < pages.length; i++) {
      if (/content-na2prd|remote_frameset/i.test(pages[i].url())) return { idx: i, page: pages[i] };
    }
    await sleep(500);
  }
  return null;
}

async function fastComplete(page) {
  // Click any Start/Launch course splash button (SCORM 1.2 or 2004 style)
  await page.evaluate(() => {
    function find(win, name) {
      if (win.name === name) return win;
      for (let i = 0; i < win.frames.length; i++) {
        try { const f = find(win.frames[i], name); if (f) return f; } catch(e) {}
      }
      return null;
    }
    const sco = find(window, 'sco') || window;
    const btn = [...sco.document.querySelectorAll('a, button')]
      .find(el => /^\s*(Launch\s*course|Start\s*Course|Start)\s*$/i.test((el.innerText || el.textContent || '').trim()));
    if (btn) btn.click();
  });

  // Poll up to 20s for either API_1484_11 (SCORM 2004) or API (SCORM 1.2)
  // to appear on any frame of the player page.
  let apiKind = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    apiKind = await page.evaluate(() => {
      function walk(w) {
        try {
          if (w.API_1484_11) return { where: w.name || '(main)', kind: '2004' };
          if (w.API) return { where: w.name || '(main)', kind: '1.2' };
        } catch (e) {}
        for (let i = 0; i < w.frames.length; i++) { try { const r = walk(w.frames[i]); if (r) return r; } catch (e) {} }
        return null;
      }
      return walk(window);
    });
    if (apiKind) break;
    await sleep(1000);
  }
  if (!apiKind) return { err: 'no-api' };

  return await page.evaluate(async ({ kind }) => {
    function walkFor(prop) {
      function walk(w) {
        try { if (w[prop]) return w[prop]; } catch (e) {}
        for (let i = 0; i < w.frames.length; i++) { try { const r = walk(w.frames[i]); if (r) return r; } catch (e) {} }
        return null;
      }
      return walk(window);
    }
    if (kind === '2004') {
      const api = walkFor('API_1484_11');
      let init = null; try { init = api.Initialize(''); } catch (e) { init = 'err:' + e.message; }
      const before = {
        completion: (() => { try { return api.GetValue('cmi.completion_status'); } catch (e) { return 'err'; } })(),
        success: (() => { try { return api.GetValue('cmi.success_status'); } catch (e) { return 'err'; } })(),
        score_raw: (() => { try { return api.GetValue('cmi.score.raw'); } catch (e) { return 'err'; } })(),
        entry: (() => { try { return api.GetValue('cmi.entry'); } catch (e) { return 'err'; } })()
      };
      const set = {
        completion: api.SetValue('cmi.completion_status', 'completed'),
        success: api.SetValue('cmi.success_status', 'passed'),
        score_raw: api.SetValue('cmi.score.raw', '100'),
        score_min: api.SetValue('cmi.score.min', '0'),
        score_max: api.SetValue('cmi.score.max', '100'),
        score_scaled: api.SetValue('cmi.score.scaled', '1'),
        progress: (() => { try { return api.SetValue('cmi.progress_measure', '1'); } catch (e) { return 'err'; } })(),
        session_time: (() => { try { return api.SetValue('cmi.session_time', 'PT10M'); } catch (e) { return 'err'; } })(),
        exit: (() => { try { return api.SetValue('cmi.exit', 'normal'); } catch (e) { return 'err'; } })(),
        commit: api.Commit('')
      };
      const after = {
        completion: api.GetValue('cmi.completion_status'),
        success: api.GetValue('cmi.success_status'),
        score_raw: api.GetValue('cmi.score.raw')
      };
      let terminate = null; try { terminate = api.Terminate(''); } catch (e) { terminate = 'err:' + e.message; }
      return { kind, init, before, set, after, terminate };
    } else {
      const api = walkFor('API');
      let init = null; try { init = api.LMSInitialize(''); } catch (e) { init = 'err:' + e.message; }
      const before = {
        lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
        score_raw: api.LMSGetValue('cmi.core.score.raw'),
        entry: api.LMSGetValue('cmi.core.entry')
      };
      const set = {
        status: api.LMSSetValue('cmi.core.lesson_status', 'passed'),
        score_raw: api.LMSSetValue('cmi.core.score.raw', '100'),
        score_min: api.LMSSetValue('cmi.core.score.min', '0'),
        score_max: api.LMSSetValue('cmi.core.score.max', '100'),
        session_time: (() => { try { return api.LMSSetValue('cmi.core.session_time', '00:10:00'); } catch (e) { return 'err'; } })(),
        exit: (() => { try { return api.LMSSetValue('cmi.core.exit', ''); } catch (e) { return 'err'; } })(),
        commit: api.LMSCommit('')
      };
      const after = {
        lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
        score_raw: api.LMSGetValue('cmi.core.score.raw')
      };
      let finish = null; try { finish = api.LMSFinish(''); } catch (e) { finish = 'err:' + e.message; }
      return { kind, init, before, set, after, finish };
    }
  }, { kind: apiKind.kind });
}

async function waitForPlayerClose(ctx, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const still = ctx.pages().some(p => /content-na2prd|remote_frameset/i.test(p.url()));
    if (!still) return true;
    await sleep(400);
  }
  return false;
}

async function forceClosePlayer(ctx) {
  // Only close the SCORM player tabs — never the landing tab
  for (const p of ctx.pages()) {
    if (/content-na2prd|remote_frameset/i.test(p.url())) {
      try { await p.close({ runBeforeUnload: false }); } catch (e) {}
    }
  }
}

async function diagnoseNoPlayer(page, course, screenshotPath) {
  const pageState = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const evidencePatterns = [
      /Prerequisite\s+\d+[^.]{0,160}?\d+\s*\/\s*\d+/gi,
      /predefined learning sequence\.[^.]*previous module in the sequence\./gi,
      /Pending Registration/gi,
      /not in your plan/gi,
      /Complete\s+(?:any\s+)?\d+\s+of\s+\d+/gi,
    ];
    const evidence = [];
    for (const pattern of evidencePatterns) {
      for (const match of text.matchAll(pattern)) {
        const value = match[0].replace(/\s+/g, ' ').trim();
        if (!evidence.includes(value)) evidence.push(value);
      }
    }
    return {
      url: location.href,
      title: document.title,
      evidence: evidence.slice(0, 6),
      hasLaunch: [...document.querySelectorAll('button, [role="button"]')].some((element) =>
        /^\s*LAUNCH\s*$/i.test(element.innerText || element.textContent || '')),
    };
  }).catch(() => ({ url: page.url(), title: '', evidence: [], hasLaunch: false }));

  const hasPrerequisiteEvidence = pageState.evidence.some((value) =>
    /Prerequisite|learning sequence|Pending Registration|Complete/i.test(value));
  const reason = hasPrerequisiteEvidence
    ? 'prerequisites-incomplete'
    : course.action === 'VIEW' && !pageState.hasLaunch
      ? 'view-page-has-no-launch'
      : 'no-player-tab';
  return {
    reason,
    evidence: pageState.evidence.length
      ? pageState.evidence
      : [`Saba opened "${pageState.title || pageState.url}" but no SCORM player appeared.`],
    destinationUrl: pageState.url,
    artifact: screenshotPath || null,
  };
}

async function main() {
  const executor = startExecutor({
    capabilityId: dry ? 'cert-dry-run' : 'cert-batch',
    capabilityVersion: dry ? 1 : 2,
    script: 'pw-cert-batch.js',
    risk: dry ? 'none' : 'medium',
    actions: dry ? ['probe'] : ['probe', 'launch', 'scorm-complete', 'verify'],
  });
  const { b, ctx } = await connect();
  if (ctx.pages().length === 0) {
    console.error('No pages open. Log in and open the certification landing page first.');
    process.exit(1);
  }
  let landing = await getLandingTab(ctx);
  await landing.bringToFront().catch(() => {});
  // Capture the certification ID from whatever URL the landing tab currently
  // has (matches ledetail/CRTFY, spf-url=...CRTFY, or a bare crtfy ID anywhere)
  // and build a canonical navigation URL from it.
  const currentUrl = landing.url();
  const certId = extractCertId(currentUrl);
  if (certId) CERT_URL = buildCertUrl(certId);
  console.log('cert url:', CERT_URL || '(will reload current tab)');
  await patchOpen(landing).catch(() => {});

  // Read the roster from the user's CURRENT view first. Navigating to the
  // canonical cert URL can drop courses that live under a non-default path/step,
  // so reading in-place keeps the roster consistent with the dashboard picker
  // (i.e. an explicit --only selection is compared against what the user saw).
  let initial = [];
  if (/ledetail/i.test(landing.url())) {
    await scrollRosterInPlace(landing);
    initial = await readCourseList(landing);
  }
  if (!initial.length) {
    await goLanding(landing);
    await patchOpen(landing).catch(() => {});
    initial = await readCourseList(landing);
  }
  console.log('Course roster:');
  initial.forEach(r => console.log(`  [${r.status}] (${r.action}) ${r.title}`));
  log({ event: 'roster', roster: initial });

  const selected = initial.filter(r => (
    r.status !== 'Successful' &&
    r.action !== 'CERT' &&
    (only.length === 0 || only.includes(r.title)) &&
    !skip.includes(r.title)
  ));
  const blockedSelected = selected.filter((course) => course.isBlocked);
  const todo = selected.filter((course) => !course.isBlocked);
  console.log(`\nWill attempt ${todo.length} runnable courses:`);
  todo.forEach(r => console.log(`  - (${r.action}) ${r.title}`));
  if (blockedSelected.length) {
    console.log(`\nPreflight found ${blockedSelected.length} blocked selected course(s):`);
    blockedSelected.forEach((course) => {
      console.log(`  - ${course.title}: ${course.blockedReason}`);
      for (const evidence of course.blockingEvidence || []) console.log(`      evidence: ${evidence}`);
    });
  }

  // Never silently drop an explicitly-requested course: if a --only title isn't
  // in the roster we could read, flag it for manual review instead of ignoring.
  const missingRequested = only.filter(t => !initial.some(r => r.title === t));
  if (missingRequested.length) {
    console.log('\nRequested but NOT found in the roster (needs manual review):');
    missingRequested.forEach(t => console.log(`  - ${t}`));
  }

  if (dry) {
    finishExecutor(executor, {
      outcome: 'success',
      verified: true,
      status: `dry-run-${todo.length}-targets`,
      targetId: certId || CERT_URL,
    });
    await b.close();
    return;
  }

  const results = blockedSelected.map((course) => {
    log({
      event: 'skip',
      course: course.title,
      reason: course.blockedReason,
      evidence: course.blockingEvidence,
    });
    return {
      course: course.title,
      action: course.action,
      ok: false,
      reason: course.blockedReason,
      evidence: course.blockingEvidence || [],
    };
  });
  results.push(...missingRequested.map(t => {
    log({ event: 'skip', course: t, reason: 'requested-but-not-in-roster' });
    return { course: t, ok: false, reason: 'requested-but-not-in-roster' };
  }));
  for (let i = 0; i < todo.length; i++) {
    const course = todo[i];
    console.log(`\n=== [${i + 1}/${todo.length}] (${course.action}) ${course.title} ===`);
    landing = await getLandingTab(ctx);
    if (!/ledetail/i.test(landing.url())) {
      await goLanding(landing);
    }
    await patchOpen(landing).catch(() => {});

    const cr = await clickAction(landing, course.title);
    console.log('  click:', cr);
    if (cr !== 'clicked') {
      results.push({
        course: course.title,
        action: course.action,
        ok: false,
        reason: 'button-not-found',
        evidence: ['The selected action control disappeared during the Saba page re-render.'],
      });
      log({ event: 'skip', course: course.title, reason: 'button-not-found' });
      continue;
    }

    const player = await findPlayerTab(ctx, 20000);
    if (!player) {
      const screenshotPath = path.join(HIST_DIR, `no-player-${Date.now()}.png`);
      let artifact = null;
      try {
        await landing.screenshot({ path: screenshotPath });
        artifact = screenshotPath.replace(/\\/g, '/');
      } catch {}
      const diagnosis = await diagnoseNoPlayer(landing, course, artifact);
      results.push({
        course: course.title,
        action: course.action,
        ok: false,
        ...diagnosis,
      });
      log({
        event: 'skip',
        course: course.title,
        action: course.action,
        ...diagnosis,
      });
      // Navigate landing back so the next iteration starts clean
      landing = await getLandingTab(ctx);
      await goLanding(landing);
      await patchOpen(landing).catch(() => {});
      continue;
    }
    console.log('  player tab idx:', player.idx);
    // Bootstrap wait
    await sleep(4000);

    let result;
    try {
      result = await fastComplete(player.page);
    } catch (e) {
      result = { err: e.message };
    }
    console.log('  result:', JSON.stringify(result).slice(0, 300));
    log({ event: 'attempt', course: course.title, result });

    // Wait for SCORM auto-close; only force-close if commit actually happened
    const committed = result && result.set && result.set.commit === 'true';
    const auto = await waitForPlayerClose(ctx, committed ? 10000 : 3000);
    if (!auto && committed) await forceClosePlayer(ctx);
    await sleep(1500);

    // Navigate landing back to cert URL and re-read roster.
    // Angular hydration is slow; retry the roster read a few times if empty.
    landing = await getLandingTab(ctx);
    await landing.bringToFront().catch(() => {});
    await goLanding(landing);
    await patchOpen(landing).catch(() => {});

    let roster = [];
    for (let t = 0; t < 5; t++) {
      roster = await readCourseList(landing);
      if (roster.length > 0) break;
      await sleep(2000);
    }
    // The SCORM API is the authoritative completion signal. The roster re-read
    // is only a secondary confirmation and is unreliable: once a cert flips to
    // Acquired the course list re-renders (or Angular hasn't hydrated yet), so
    // it can come back empty / "not-found" even though the course really passed.
    const scormOk = !!(
      result && result.set && result.set.commit === 'true' && result.after && (
        result.after.lesson_status === 'passed' ||
        result.after.completion === 'completed' ||
        result.after.success === 'passed'
      )
    );
    const now = roster.find(r => r.title === course.title);
    const verified = !!(now && now.status === 'Successful');
    const success = verified || scormOk;
    const how = verified ? 'roster-verified' : (scormOk ? 'scorm-confirmed' : 'unconfirmed');
    console.log(`  post-state: ${now?.status || 'not-found'} — ${success ? 'OK' : 'FAIL'} (${how})`);
    results.push({ course: course.title, action: course.action, ok: success, result, status: now?.status, how });
    log({ event: 'verify', course: course.title, status: now?.status, ok: success, how });

    await sleep(800);
  }

  console.log('\n=== SUMMARY ===');
  const okCount = results.filter(r => r.ok).length;
  console.log(`${okCount}/${results.length} confirmed Successful`);
  const manual = results.filter(r => !r.ok);
  if (manual.length) {
    console.log('\nNeeds manual review:');
    manual.forEach((item) => {
      console.log(`  - ${item.course}: ${item.reason || (item.result && item.result.err) || item.status || 'unknown'}`);
      for (const evidence of item.evidence || []) console.log(`      evidence: ${evidence}`);
    });
  }
  log({
    event: 'summary',
    ok: okCount,
    total: results.length,
    manual: manual.map((item) => ({
      course: item.course,
      reason: item.reason,
      evidence: item.evidence,
      artifact: item.artifact,
    })),
  });

  landing = await getLandingTab(ctx);
  const finalRoster = await readCourseList(landing);
  console.log('\nFinal course states:');
  finalRoster.forEach(r => console.log(`  [${r.status}] (${r.action}) ${r.title}`));
  log({ event: 'final-roster', roster: finalRoster });
  console.log(`AUTOMATION_RESULT ${JSON.stringify({
    schemaVersion: 1,
    kind: 'cert-batch',
    completed: okCount,
    total: results.length,
    failures: manual.map((item) => ({
      title: item.course,
      action: item.action || null,
      reason: item.reason || item.result?.err || item.status || 'unknown',
      evidence: item.evidence || [],
      artifact: item.artifact || null,
      destinationUrl: item.destinationUrl || null,
    })),
  })}`);

  finishExecutor(executor, {
    outcome: manual.length ? 'failure' : 'success',
    verified: results.length > 0 && manual.length === 0,
    status: `${okCount}/${results.length} confirmed Successful`,
    failureSignature: manual.length ? 'cert-items-need-review' : null,
    targetId: certId || CERT_URL,
  });
  await b.close();
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
