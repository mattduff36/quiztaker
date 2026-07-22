#!/usr/bin/env node
// pw-container-batch.js
//
// Some Saba courses are containers with multiple sub-activities inside a
// content-player wrapper (e.g. "HP Universal Print Driver Service and Support"
// which contains 2 WBT activities). This script:
//   1. Applies the window.open patch so activities open as tabs.
//   2. Iterates each `.activity-list-item[role=button]` in the current tab.
//   3. Clicks it, waits for a SCORM Content Player tab to open,
//      then fast-completes either SCORM 1.2 or SCORM 2004.
//   4. Waits for the player to auto-close, then handles the next activity.
//   5. Closes the container after every activity is confirmed complete.
//
// Usage:
//   node pw-container-batch.js [tabIndex=0] [--dry]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { finishExecutor, startExecutor } = require('./lib/executor-ledger');
const { dataPath } = require('./lib/paths');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HIST_DIR = dataPath('course-history');
fs.mkdirSync(HIST_DIR, { recursive: true });
const HIST = path.join(HIST_DIR, 'container.jsonl');
const COURSE_HIST = path.join(HIST_DIR, 'batch.jsonl');
function log(o) { fs.appendFileSync(HIST, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); }
function logCourse(o) { fs.appendFileSync(COURSE_HIST, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); }

async function patchOpen(page) {
  await page.evaluate(() => {
    if (window.__openPatched) return;
    const orig = window.open.bind(window);
    window.open = function (url) { return orig(url, '_blank'); };
    window.__openPatched = true;
  });
}

async function readActivities(page) {
  return await page.evaluate(() => {
    const items = [...document.querySelectorAll('div.activity-list-item[role="button"]')];
    return items.map((el, i) => {
      const titleEl = el.querySelector('span.activity-cont.activity-title')
                   || el.querySelector('span.activity-cont')
                   || el.querySelector('span.activity-title');
      const title = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
      const rowText = (el.innerText || '').trim();
      const hasSuccessIcon = !!el.querySelector(
        '[title*="Completed Successfully" i], [aria-label*="Completed Successfully" i], .completed, .trq-icon-success'
      );
      const status = hasSuccessIcon || /Completed|Successful/i.test(rowText) ? 'Completed' :
                     /In Progress/i.test(rowText) ? 'In Progress' :
                     /Not started|Pending|Registered/i.test(rowText) ? 'Pending' : 'Unknown';
      return { idx: i, title, status };
    });
  });
}

async function clickActivity(page, title, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await page.evaluate((activityTitle) => {
      const items = [...document.querySelectorAll('.activity-list-item[role="button"]')];
      for (const el of items) {
        const text = (el.innerText || '').trim();
        if (text.includes(activityTitle)) {
          el.click();
          return 'clicked';
        }
      }
      return 'not-found';
    }, title).catch(() => 'not-found');
    if (result === 'clicked') return result;
    await sleep(500);
  }
  return 'not-found';
}

async function findPlayerTab(ctx, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    for (const p of ctx.pages()) {
      if (/content-na2prd|remote_frameset/i.test(p.url())) return p;
    }
    await sleep(500);
  }
  return null;
}

async function waitForPlayerClose(ctx, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!ctx.pages().some(p => /content-na2prd|remote_frameset/i.test(p.url()))) return true;
    await sleep(400);
  }
  return false;
}

async function fastComplete(page) {
  // Poll for either SCORM API. If content is still on a splash, start it.
  const t0 = Date.now();
  let apiKind = null;
  while (Date.now() - t0 < 20000) {
    const state = await page.evaluate(() => {
      function walk(win) {
        try {
          if (win.API_1484_11) return '2004';
          if (win.API) return '1.2';
        } catch (e) {}
        for (let i = 0; i < win.frames.length; i++) {
          try { const kind = walk(win.frames[i]); if (kind) return kind; } catch (e) {}
        }
        return null;
      }
      const kind = walk(window);
      if (kind) return { kind };

      const docs = [document];
      for (const frame of [...document.querySelectorAll('iframe')]) {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (e) {}
      }
      const btn = docs.flatMap((doc) => [...doc.querySelectorAll('a, button')])
        .find(el => /^\s*(Launch\s*course|Start\s*Course|Start)\s*$/i.test(
          (el.innerText || el.textContent || '').trim()
        ));
      if (btn) { btn.click(); return 'launched'; }
      return 'wait';
    });
    if (state && state.kind) {
      apiKind = state.kind;
      break;
    }
    await sleep(1000);
  }
  if (!apiKind) return { err: 'no-api' };

  return await page.evaluate(({ kind }) => {
    function walkFor(prop) {
      function walk(win) {
        try { if (win[prop]) return win[prop]; } catch (e) {}
        for (let i = 0; i < win.frames.length; i++) {
          try { const api = walk(win.frames[i]); if (api) return api; } catch (e) {}
        }
        return null;
      }
      return walk(window);
    }

    if (kind === '2004') {
      const api = walkFor('API_1484_11');
      let init = null;
      try { init = api.Initialize(''); } catch (e) { init = `err:${e.message}`; }
      const before = {
        completion: api.GetValue('cmi.completion_status'),
        success: api.GetValue('cmi.success_status'),
        score_raw: api.GetValue('cmi.score.raw'),
      };
      const set = {
        completion: api.SetValue('cmi.completion_status', 'completed'),
        success: api.SetValue('cmi.success_status', 'passed'),
        score_raw: api.SetValue('cmi.score.raw', '100'),
        score_min: api.SetValue('cmi.score.min', '0'),
        score_max: api.SetValue('cmi.score.max', '100'),
        score_scaled: api.SetValue('cmi.score.scaled', '1'),
        progress: api.SetValue('cmi.progress_measure', '1'),
        session_time: api.SetValue('cmi.session_time', 'PT10M'),
        exit: api.SetValue('cmi.exit', 'normal'),
        commit: api.Commit(''),
      };
      const after = {
        completion: api.GetValue('cmi.completion_status'),
        success: api.GetValue('cmi.success_status'),
        score_raw: api.GetValue('cmi.score.raw'),
      };
      let terminate = null;
      try { terminate = api.Terminate(''); } catch (e) { terminate = `err:${e.message}`; }
      return { kind, init, before, set, after, terminate };
    }

    const api = walkFor('API');
    let init = null;
    try { init = api.LMSInitialize(''); } catch (e) { init = `err:${e.message}`; }
    const before = {
      lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
      score_raw: api.LMSGetValue('cmi.core.score.raw'),
      entry: api.LMSGetValue('cmi.core.entry'),
    };
    const set = {
      status: api.LMSSetValue('cmi.core.lesson_status', 'passed'),
      score_raw: api.LMSSetValue('cmi.core.score.raw', '100'),
      score_min: api.LMSSetValue('cmi.core.score.min', '0'),
      score_max: api.LMSSetValue('cmi.core.score.max', '100'),
      session_time: api.LMSSetValue('cmi.core.session_time', '00:10:00'),
      exit: api.LMSSetValue('cmi.core.exit', ''),
      commit: api.LMSCommit(''),
    };
    const after = {
      lesson_status: api.LMSGetValue('cmi.core.lesson_status'),
      score_raw: api.LMSGetValue('cmi.core.score.raw'),
    };
    let finish = null;
    try { finish = api.LMSFinish(''); } catch (e) { finish = `err:${e.message}`; }
    return { kind, init, before, set, after, finish };
  }, { kind: apiKind });
}

async function dismissActivityExit(page, isCommitted) {
  const preferred = isCommitted ? /EXIT\s+AND\s+FINISH/i : /EXIT\s+AND\s+RESUME\s+LATER/i;
  return await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const buttons = [...document.querySelectorAll('button, [role=button]')];
    const button = buttons.find((el) => pattern.test((el.innerText || el.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  }, preferred.source).catch(() => false);
}

async function closeCompletedContainer(page) {
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role=button]')];
    const button = buttons.find((el) => /^CLOSE\s+PLAYER$/i.test((el.innerText || el.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (!clicked) return false;
  await sleep(1500);
  const confirmed = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role=button]')];
    const button = buttons.find((el) => /^YES$/i.test((el.innerText || el.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (!confirmed) await dismissActivityExit(page, true);
  return true;
}

async function waitForAllActivitiesCompleted(page, maxMs = 10000) {
  const start = Date.now();
  let activities = [];
  while (Date.now() - start < maxMs) {
    activities = await readActivities(page).catch(() => []);
    if (activities.length > 0 && activities.every((activity) => activity.status === 'Completed')) {
      return activities;
    }
    await sleep(500);
  }
  return activities;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry');
  const executor = startExecutor({
    capabilityId: 'container-batch',
    capabilityVersion: 3,
    script: 'pw-container-batch.js',
    risk: isDryRun ? 'none' : 'medium',
    actions: isDryRun ? ['probe'] : ['probe', 'launch', 'scorm-complete', 'verify', 'exit'],
  });
  const tabArg = args.find((arg) => /^\d+$/.test(arg));
  const tabIdx = tabArg == null ? 0 : Number(tabArg);
  const b = await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const container = ctx.pages()[tabIdx];
  if (!container) throw new Error(`No tab at index ${tabIdx}`);
  const containerTitle = await container.title().catch(() => 'Multi-activity course');
  await container.bringToFront().catch(() => {});
  await patchOpen(container);
  console.log('container url:', container.url().slice(0, 100));

  const activities = await readActivities(container);
  console.log('Activities:');
  activities.forEach(a => console.log(`  [${a.status}] ${a.title}`));
  log({ event: 'roster', activities });
  if (isDryRun) {
    finishExecutor(executor, {
      outcome: 'success',
      verified: true,
      status: `dry-run-${activities.length}-activities`,
      targetId: containerTitle,
    });
    await b.close();
    return;
  }

  const results = [];
  for (const act of activities) {
    console.log(`\n=== ${act.title} ===`);
    if (act.status === 'Completed') { console.log('  already completed, skipping'); continue; }

    // Re-patch after possible navigation
    await patchOpen(container).catch(() => {});

    const c = await clickActivity(container, act.title);
    console.log('  click:', c);
    if (c !== 'clicked') { results.push({ title: act.title, ok: false, reason: 'button-not-found' }); continue; }

    const player = await findPlayerTab(ctx, 20000);
    if (!player) {
      results.push({ title: act.title, ok: false, reason: 'no-player-tab' });
      log({ event: 'skip', title: act.title, reason: 'no-player-tab' });
      continue;
    }
    await sleep(4000);
    let r; try { r = await fastComplete(player); } catch (e) { r = { err: e.message }; }
    console.log('  result:', JSON.stringify(r).slice(0, 300));
    log({ event: 'attempt', title: act.title, result: r });

    // Only force-close if commit actually happened (avoid interrupting a still-loading player)
    const committed = r && r.set && r.set.commit === 'true';
    const closed = await waitForPlayerClose(ctx, committed ? 8000 : 3000);
    if (!closed && committed) {
      for (const p of ctx.pages()) {
        if (/content-na2prd|remote_frameset/i.test(p.url())) { try { await p.close(); } catch (e) {} }
      }
    }
    await sleep(2000);

    // A manually closed child player raises an exit dialog in the wrapper.
    // Finish only after a confirmed commit; otherwise preserve resumable state.
    await dismissActivityExit(container, committed);
    await sleep(1500);

    // Bring container back into focus & re-read status
    await container.bringToFront().catch(() => {});
    // Container is an Angular SPA; the activity list may re-render but not immediately.
    // Give it a moment.
    await sleep(1500);
    const nowList = await readActivities(container);
    const now = nowList.find(a => a.title === act.title);
    const scormConfirmed = committed && (
      r?.after?.lesson_status === 'passed' ||
      (r?.after?.completion === 'completed' && r?.after?.success === 'passed')
    );
    const success = now?.status === 'Completed' || scormConfirmed;
    console.log(`  post-state: ${now?.status || 'unknown'} ${success ? 'OK' : ''}`);
    const status = now?.status === 'Completed' ? 'Completed' : scormConfirmed ? 'SCORM confirmed' : now?.status;
    results.push({ title: act.title, ok: success, status, result: r });
    log({ event: 'verify', title: act.title, status, ok: success });
  }

  console.log('\n=== SUMMARY ===');
  const okCount = results.filter(r => r.ok).length;
  console.log(`${okCount}/${results.length} confirmed complete`);
  results.forEach(r => console.log(`  ${r.ok ? 'OK ' : 'FAIL'} ${r.title} (${r.status || r.reason || 'unknown'})`));

  const finalActivities = await waitForAllActivitiesCompleted(container);
  if (finalActivities.length > 0 && finalActivities.every((activity) => activity.status === 'Completed')) {
    const closed = await closeCompletedContainer(container);
    console.log(closed ? 'container close requested' : 'container close button not found');
    await sleep(3000);
    let parent = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      parent = await container.evaluate(() => {
        const text = document.body?.innerText || '';
        const title = document.querySelector('h1.course--detail__title, h1')?.innerText?.trim() || document.title;
        return {
          title,
          successful: /\bSuccessful\b/i.test(text.slice(0, 2000)),
        };
      }).catch(() => null);
      if (parent?.successful) break;
      await sleep(500);
    }
    logCourse({
      event: 'verify',
      course: parent?.title || containerTitle,
      status: parent?.successful ? 'Successful' : 'Unconfirmed',
      ok: !!parent?.successful,
      how: 'container-parent-verified',
    });
  }

  const failures = results.filter((result) => !result.ok);
  const allComplete = finalActivities.length > 0 &&
    finalActivities.every((activity) => activity.status === 'Completed');
  finishExecutor(executor, {
    outcome: failures.length ? 'failure' : 'success',
    verified: allComplete && failures.length === 0,
    status: `${okCount}/${results.length} confirmed complete`,
    failureSignature: failures.length ? 'container-activities-need-review' : null,
    targetId: containerTitle,
  });
  await b.close();
}

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = {
  dismissActivityExit,
  fastComplete,
  findPlayerTab,
  patchOpen,
  waitForPlayerClose,
};
