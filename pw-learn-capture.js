#!/usr/bin/env node
// Capture an unfamiliar page for guided learning. Read-only: screenshots, DOM
// summaries, visible text, and same-origin frame details go under data/learn/.
//
// Usage:
//   node pw-learn-capture.js [tabIdx]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { probePage } = require('./lib/page-probe');
const { queueReview, suggestNextAction } = require('./lib/learning-engine');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const ROOT = __dirname;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const args = process.argv.slice(2);
  const tabArg = args.find((arg) => /^\d+$/.test(arg));
  const tabIdx = tabArg == null ? 0 : Number(tabArg);
  const detectedArg = args.find((arg) => arg.startsWith('--detected='));
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    const page = pages[tabIdx];
    if (!page) throw new Error(`No tab at index ${tabIdx}`);

    const dir = path.join(ROOT, 'data', 'learn', stamp());
    fs.mkdirSync(dir, { recursive: true });

    const title = await page.title().catch(() => '');
    const url = page.url();
    const normalizedProbe = await probePage(page, tabIdx);
    const detected = detectedArg
      ? detectedArg.slice(detectedArg.indexOf('=') + 1)
      : normalizedProbe.urlKind;
    const shotPath = path.join(dir, 'page.png');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    const capture = await page.evaluate(() => {
      function textOf(el) {
        return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      }
      function walkFrames(w, acc = []) {
        let item = { url: '', name: '', accessible: false, textPreview: '', globals: {}, counts: {} };
        try {
          item = {
            url: w.location.href,
            name: w.name || '',
            accessible: true,
            textPreview: textOf(w.document.body).slice(0, 1500),
            globals: {
              hasAPI: !!w.API,
              hasAPI1484: !!w.API_1484_11,
              hasQuizJSON: !!(w.quizJSON && Array.isArray(w.quizJSON.questions)),
            },
            counts: {
              frames: w.frames.length,
              buttons: w.document.querySelectorAll('button, a, [role="button"]').length,
              inputs: w.document.querySelectorAll('input, textarea, select').length,
              radios: w.document.querySelectorAll('input[type="radio"]').length,
              checks: w.document.querySelectorAll('input[type="checkbox"]').length,
            },
          };
        } catch (e) {
          item.error = e.message;
        }
        acc.push(item);
        try {
          for (let i = 0; i < w.frames.length; i++) walkFrames(w.frames[i], acc);
        } catch (e) {}
        return acc;
      }

      const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
        .map((el) => ({
          text: textOf(el).slice(0, 140),
          title: el.getAttribute('title') || '',
          aria: el.getAttribute('aria-label') || '',
          visible: !!el.offsetParent,
        }))
        .filter((b) => b.text || b.title || b.aria)
        .slice(0, 120);

      return {
        visibleText: textOf(document.body),
        htmlPreview: document.documentElement.outerHTML.slice(0, 250000),
        buttons,
        frames: walkFrames(window),
      };
    });

    const relativeDir = path.relative(ROOT, dir).replace(/\\/g, '/');
    const meta = {
      schemaVersion: 2,
      tabIdx,
      title,
      url,
      detected,
      fingerprint: normalizedProbe.fingerprint,
      attemptId: process.env.SABA_ATTEMPT_ID || null,
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'visible-text.txt'), capture.visibleText || '');
    fs.writeFileSync(path.join(dir, 'dom-preview.html'), capture.htmlPreview || '');
    fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify({ buttons: capture.buttons, frames: capture.frames }, null, 2));
    fs.writeFileSync(path.join(dir, 'normalized-probe.json'), JSON.stringify(normalizedProbe, null, 2));
    const indexFile = path.join(ROOT, 'data', 'learn', 'index.jsonl');
    fs.appendFileSync(indexFile, `${JSON.stringify({ ...meta, dir: relativeDir })}\n`);

    if (['unknown', 'external-tool', 'document-wbt', 'server-assessment'].includes(detected)) {
      const nextAction = suggestNextAction(normalizedProbe.fingerprint, detected);
      queueReview({
        type: 'new-fingerprint',
        title: `Review ${detected} capture`,
        fingerprint: normalizedProbe.fingerprint,
        attemptId: meta.attemptId,
        artifact: relativeDir,
        detail: `${title} — ${url}`,
        nextAction: nextAction.detail,
      });
    }

    console.log(JSON.stringify({
      ok: true,
      dir: relativeDir,
      files: ['meta.json', 'visible-text.txt', 'dom-preview.html', 'probe.json', 'normalized-probe.json', 'page.png'],
      title,
      url,
      detected,
      fingerprint: normalizedProbe.fingerprint,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
