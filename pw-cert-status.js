#!/usr/bin/env node
// pw-cert-status.js
//
// Prints the current certification landing page's roster as JSON, without
// running the batch. Used by the dashboard (GET /api/cert) and handy from the
// terminal to see "where am I / what's left".
//
// Output shape:
//   { certId, certTitle, pathPct, url, courses: [{ title, status, action }] }
// If no ledetail tab is open, prints { certId: null } so callers can show an
// empty state rather than erroring.
//
// Usage: node pw-cert-status.js

const { chromium } = require('playwright');
const {
  extractCertId,
  getLandingTab,
  readCourseList,
  readCertMeta,
} = require('./lib/cert-status');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    if (!ctx || ctx.pages().length === 0) {
      console.log(JSON.stringify({ certId: null, reason: 'no-pages' }));
      return;
    }
    const landing = getLandingTab(ctx);
    const url = landing.url();
    const certId = extractCertId(url);
    if (!certId || !/ledetail/i.test(url)) {
      console.log(JSON.stringify({ certId: null, reason: 'no-ledetail-tab', url }));
      return;
    }
    const courses = await readCourseList(landing);
    const meta = await readCertMeta(landing);
    console.log(JSON.stringify({
      certId,
      certTitle: meta.certTitle,
      pathPct: meta.pathPct,
      url,
      courses,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
