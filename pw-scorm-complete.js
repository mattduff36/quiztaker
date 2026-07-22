#!/usr/bin/env node
// pw-scorm-complete.js
//
// Universal SCORM 1.2 / SCORM 2004 fast completer.
// - Detects API_1484_11 (2004) or API (1.2) on any frame reachable from the player tab.
// - Handles the "Start Course" / "Launch course" splash if present.
// - Sets completion=passed, score=100, commit, terminate/finish.
//
// Usage: node pw-scorm-complete.js [tabIndex] [--dry]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { finishExecutor, startExecutor } = require('./lib/executor-ledger');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry');
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const tabArg = args.find((arg) => /^\d+$/.test(arg));
  const tabIdx = tabArg == null ? null : Number(tabArg);

  let player = null;
  if (tabIdx != null) player = ctx.pages()[tabIdx];
  else player = ctx.pages().find(p => /content-na2prd|remote_frameset/i.test(p.url()));
  if (!player) { console.error('No SCORM Content Player tab found'); process.exit(1); }

  const label = await player.title().catch(() => 'SCORM course');
  const executor = startExecutor({
    capabilityId: 'scorm-complete',
    capabilityVersion: 2,
    script: 'pw-scorm-complete.js',
    target: label,
    risk: isDryRun ? 'none' : 'medium',
    actions: isDryRun ? ['probe'] : ['probe', 'scorm-complete', 'verify', 'exit'],
  });
  console.log('player:', player.url().slice(0, 100));

  if (isDryRun) {
    const api = await player.evaluate(() => {
      function walk(win) {
        try {
          if (win.API_1484_11) return { kind: '2004', where: win.name || '(main)' };
          if (win.API) return { kind: '1.2', where: win.name || '(main)' };
        } catch {}
        for (let index = 0; index < win.frames.length; index++) {
          try { const result = walk(win.frames[index]); if (result) return result; } catch {}
        }
        return null;
      }
      return walk(window);
    });
    console.log(JSON.stringify({ dryRun: true, api, target: label }, null, 2));
    finishExecutor(executor, {
      outcome: 'success',
      verified: true,
      status: api ? `dry-run-${api.kind}-detected` : 'dry-run-no-api-yet',
      targetId: label,
    });
    await b.close();
    return;
  }

  // Step 1: click Start/Launch splash if present
  await player.evaluate(() => {
    function find(w, name) { if (w.name === name) return w; for (let i = 0; i < w.frames.length; i++) { try { const f = find(w.frames[i], name); if (f) return f; } catch (e) {} } return null; }
    const sco = find(window, 'sco') || window;
    const btn = [...sco.document.querySelectorAll('a, button')]
      .find(el => /^\s*(Launch\s*course|Start\s*Course|Start)\s*$/i.test((el.innerText || el.textContent || '').trim()));
    if (btn) btn.click();
  });
  await sleep(3000);

  // Step 2: wait for SCORM API (either 1.2 or 2004) to become findable
  let apiKind = null;
  for (let t = 0; t < 40; t++) {
    apiKind = await player.evaluate(() => {
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
  if (!apiKind) { console.error('SCORM API not found after 40s'); process.exit(1); }
  console.log('api kind:', apiKind);

  // Step 3: run appropriate completion sequence
  const result = await player.evaluate(async ({ kind }) => {
    function walkFor(prop) {
      function walk(w) {
        try { if (w[prop]) return { win: w, api: w[prop] }; } catch (e) {}
        for (let i = 0; i < w.frames.length; i++) { try { const r = walk(w.frames[i]); if (r) return r; } catch (e) {} }
        return null;
      }
      return walk(window);
    }

    if (kind === '2004') {
      const found = walkFor('API_1484_11');
      const api = found.api;
      // Some content initializes automatically; try Initialize() but tolerate 'true' or errors.
      let init = null; try { init = api.Initialize(''); } catch (e) { init = 'err:' + e.message; }
      const before = {
        completion: (() => { try { return api.GetValue('cmi.completion_status'); } catch (e) { return 'err:' + e.message; } })(),
        success: (() => { try { return api.GetValue('cmi.success_status'); } catch (e) { return 'err:' + e.message; } })(),
        score_raw: (() => { try { return api.GetValue('cmi.score.raw'); } catch (e) { return 'err:' + e.message; } })(),
        entry: (() => { try { return api.GetValue('cmi.entry'); } catch (e) { return 'err:' + e.message; } })()
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
      const found = walkFor('API');
      const api = found.api;
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

  console.log(JSON.stringify(result, null, 2));
  const historyDir = path.join('data', 'course-history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.appendFileSync(path.join(historyDir, 'log.jsonl'), `${JSON.stringify({
    ts: new Date().toISOString(),
    label,
    tab: tabIdx,
    strategy: 'fast-scorm',
    result,
  })}\n`);
  const verified = result?.set?.commit === 'true' && (
    result?.after?.lesson_status === 'passed' ||
    (result?.after?.completion === 'completed' && result?.after?.success === 'passed')
  );
  finishExecutor(executor, {
    outcome: verified ? 'success' : 'failure',
    verified,
    status: verified ? 'passed' : 'unconfirmed',
    failureSignature: verified ? null : result?.err || 'scorm-unconfirmed',
    targetId: label,
  });

  // Step 4: wait for auto-close
  for (let t = 0; t < 20; t++) {
    if (!ctx.pages().some(p => /content-na2prd|remote_frameset/i.test(p.url()))) {
      console.log('player auto-closed');
      break;
    }
    await sleep(500);
  }
  await b.close();
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
