#!/usr/bin/env node
// pw-class-batch.js
//
// Completes a selected subset of activities from a Saba course/class detail
// page (`/me/learningeventdetail/cours...`). For each selected activity it:
//   1. Clicks the activity's LAUNCH button.
//   2. Fast-completes its SCORM 1.2 or 2004 child.
//   3. Finishes and closes the content-player wrapper.
//   4. Returns to the detail page and verifies the activity status.
//
// Usage:
//   node pw-class-batch.js [tabIndex=0] [--only="Activity Name"]... [--dry]
//   --only may be repeated; without it, every unfinished activity is attempted.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  getClassDetailTab,
  readClassActivities,
  readClassMeta,
} = require('./lib/class-status');
const {
  fastComplete,
  findPlayerTab,
  patchOpen,
  waitForPlayerClose,
} = require('./pw-container-batch');
const { finishExecutor, startExecutor } = require('./lib/executor-ledger');
const { dataPath } = require('./lib/paths');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const tabArg = argv.find((arg) => /^\d+$/.test(arg));
const tabIdx = tabArg == null ? 0 : Number(tabArg);
const isDryRun = argv.includes('--dry');
const only = argv
  .filter((arg) => /^--only=/.test(arg))
  .map((arg) => arg.slice(arg.indexOf('=') + 1));

const HISTORY_DIR = dataPath('course-history');
const ACTIVITY_HISTORY = path.join(HISTORY_DIR, 'container.jsonl');
const COURSE_HISTORY = path.join(HISTORY_DIR, 'batch.jsonl');
fs.mkdirSync(HISTORY_DIR, { recursive: true });

function log(file, value) {
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`);
}

async function waitForActivities(page, maxMs = 15000) {
  const start = Date.now();
  let activities = [];
  while (Date.now() - start < maxMs) {
    activities = await readClassActivities(page).catch(() => []);
    if (activities.length > 0) return activities;
    await sleep(500);
  }
  return activities;
}

async function goToDetail(page, detailUrl) {
  if (!/\/me\/learningeventdetail\/cours/i.test(page.url())) {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  }
  await waitForActivities(page);
  await patchOpen(page).catch(() => {});
}

async function clickActivityLaunch(page, activityTitle, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const clicked = await page.evaluate((title) => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((candidate) => {
        const label = (candidate.getAttribute('aria-label') || candidate.title || '').trim();
        const match = label.match(/^Launch for (.+?)\.?$/i);
        return match && match[1].replace(/\.$/, '').trim() === title;
      });
      if (!button) return false;
      button.click();
      return true;
    }, activityTitle).catch(() => false);
    if (clicked) return true;
    await sleep(500);
  }
  return false;
}

async function forceCloseScormPlayers(ctx) {
  for (const page of ctx.pages()) {
    if (!/content-na2prd|remote_frameset/i.test(page.url())) continue;
    try { await page.close({ runBeforeUnload: false }); } catch {}
  }
}

async function finishCurrentActivity(wrapper, isCommitted, maxMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const state = await wrapper.evaluate((committed) => {
      const buttons = [...document.querySelectorAll('button, [role=button]')];
      const finishPattern = committed
        ? /EXIT\s+AND\s+FINISH/i
        : /EXIT\s+AND\s+RESUME\s+LATER/i;
      const finish = buttons.find((button) => (
        finishPattern.test((button.innerText || button.textContent || '').trim())
      ));
      if (finish) {
        finish.click();
        return 'clicked-exit';
      }
      if (document.querySelector('.activity-list-item[role="button"]')) return 'ready';
      return 'waiting';
    }, isCommitted).catch(() => 'waiting');
    if (state === 'ready') return true;
    await sleep(state === 'clicked-exit' ? 1200 : 400);
  }
  return false;
}

async function closeWrapper(wrapper, detailUrl, maxMs = 12000) {
  const closeClicked = await wrapper.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role=button]')];
    const close = buttons.find((button) => (
      /^CLOSE\s+PLAYER$/i.test((button.innerText || button.textContent || '').trim())
    ));
    if (!close) return false;
    close.click();
    return true;
  }).catch(() => false);

  if (closeClicked) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const confirmed = await wrapper.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role=button]')];
        const yes = buttons.find((button) => (
          /^YES$/i.test((button.innerText || button.textContent || '').trim())
        ));
        if (!yes) return false;
        yes.click();
        return true;
      }).catch(() => false);
      if (confirmed) break;
      await sleep(400);
    }
  }

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (/\/me\/learningeventdetail\/cours/i.test(wrapper.url())) return;
    await sleep(400);
  }
  await wrapper.goto(detailUrl, { waitUntil: 'domcontentloaded' });
}

async function main() {
  const executor = startExecutor({
    capabilityId: 'class-batch',
    capabilityVersion: 1,
    script: 'pw-class-batch.js',
    risk: isDryRun ? 'none' : 'medium',
    actions: isDryRun ? ['probe'] : ['probe', 'launch', 'scorm-complete', 'verify', 'exit'],
  });
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx?.pages() || [];
    let detailPage = pages[tabIdx];
    if (!detailPage || !/\/me\/learningeventdetail\/cours/i.test(detailPage.url())) {
      detailPage = getClassDetailTab(ctx);
    }
    if (!detailPage || !/\/me\/learningeventdetail\/cours/i.test(detailPage.url())) {
      throw new Error('No Saba course/class detail page is open.');
    }

    const detailUrl = detailPage.url();
    await detailPage.bringToFront().catch(() => {});
    await goToDetail(detailPage, detailUrl);

    const meta = await readClassMeta(detailPage);
    const initial = await waitForActivities(detailPage);
    console.log(`Course: ${meta.classTitle || meta.courseId || detailUrl}`);
    console.log('Activities:');
    initial.forEach((activity) => {
      console.log(`  [${activity.status}] (${activity.action}) ${activity.title}`);
    });

    const eligible = initial.filter((activity) => (
      activity.status !== 'Completed' &&
      activity.action === 'LAUNCH' &&
      (only.length === 0 || only.includes(activity.title))
    ));
    const missingRequested = only.filter((title) => !initial.some((activity) => activity.title === title));

    console.log(`\nWill attempt ${eligible.length} activities:`);
    eligible.forEach((activity) => console.log(`  - ${activity.title}`));
    if (missingRequested.length) {
      console.log('\nRequested but not found:');
      missingRequested.forEach((title) => console.log(`  - ${title}`));
    }
    if (isDryRun) {
      console.log('\nDry run: no activities launched.');
      finishExecutor(executor, {
        outcome: 'success',
        verified: true,
        status: `dry-run-${eligible.length}-targets`,
        targetId: meta.courseId || meta.classTitle,
      });
      return;
    }
    log(ACTIVITY_HISTORY, { event: 'roster', course: meta.classTitle, activities: initial });

    const results = missingRequested.map((title) => ({
      title,
      ok: false,
      reason: 'requested-but-not-found',
    }));

    for (let index = 0; index < eligible.length; index++) {
      const activity = eligible[index];
      console.log(`\n=== [${index + 1}/${eligible.length}] ${activity.title} ===`);

      await goToDetail(detailPage, detailUrl);
      const clicked = await clickActivityLaunch(detailPage, activity.title);
      console.log('  click:', clicked ? 'clicked' : 'not-found');
      if (!clicked) {
        results.push({ title: activity.title, ok: false, reason: 'button-not-found' });
        log(ACTIVITY_HISTORY, { event: 'verify', title: activity.title, status: 'button-not-found', ok: false });
        continue;
      }

      const player = await findPlayerTab(ctx, 20000);
      if (!player) {
        results.push({ title: activity.title, ok: false, reason: 'no-player-tab' });
        log(ACTIVITY_HISTORY, { event: 'verify', title: activity.title, status: 'no-player-tab', ok: false });
        await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        continue;
      }

      await sleep(3000);
      let result;
      try {
        result = await fastComplete(player);
      } catch (error) {
        result = { err: error.message };
      }
      console.log('  result:', JSON.stringify(result).slice(0, 400));
      log(ACTIVITY_HISTORY, { event: 'attempt', title: activity.title, result });

      const isCommitted = result?.set?.commit === 'true';
      const autoClosed = await waitForPlayerClose(ctx, isCommitted ? 8000 : 3000);
      if (!autoClosed && isCommitted) await forceCloseScormPlayers(ctx);
      await finishCurrentActivity(detailPage, isCommitted);
      await closeWrapper(detailPage, detailUrl);
      await goToDetail(detailPage, detailUrl);

      let current;
      for (let attempt = 0; attempt < 12; attempt++) {
        const activities = await readClassActivities(detailPage).catch(() => []);
        current = activities.find((item) => item.title === activity.title);
        if (current?.status === 'Completed') break;
        await sleep(500);
      }

      const scormConfirmed = isCommitted && (
        result?.after?.lesson_status === 'passed' ||
        (result?.after?.completion === 'completed' && result?.after?.success === 'passed')
      );
      const ok = current?.status === 'Completed' || scormConfirmed;
      const status = current?.status === 'Completed'
        ? 'Completed'
        : scormConfirmed ? 'SCORM confirmed' : current?.status || 'Unknown';
      console.log(`  post-state: ${status} ${ok ? 'OK' : 'FAIL'}`);
      results.push({ title: activity.title, ok, status, result });
      log(ACTIVITY_HISTORY, { event: 'verify', title: activity.title, status, ok });
    }

    console.log('\n=== SUMMARY ===');
    const okCount = results.filter((result) => result.ok).length;
    console.log(`${okCount}/${results.length} confirmed complete`);
    results.forEach((result) => {
      console.log(`  ${result.ok ? 'OK ' : 'FAIL'} ${result.title} (${result.status || result.reason || 'unknown'})`);
    });

    await goToDetail(detailPage, detailUrl);
    const finalMeta = await readClassMeta(detailPage);
    if (finalMeta.status === 'Successful') {
      log(COURSE_HISTORY, {
        event: 'verify',
        course: finalMeta.classTitle || meta.classTitle,
        status: 'Successful',
        ok: true,
        how: 'selected-class-activities',
      });
    }
    const failures = results.filter((result) => !result.ok);
    finishExecutor(executor, {
      outcome: failures.length ? 'failure' : 'success',
      verified: results.length > 0 && failures.length === 0,
      status: `${okCount}/${results.length} confirmed complete`,
      failureSignature: failures.length ? 'class-activities-need-review' : null,
      targetId: finalMeta.courseId || finalMeta.classTitle || meta.courseId,
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
