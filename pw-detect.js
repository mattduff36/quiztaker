#!/usr/bin/env node
// pw-detect.js
//
// Thin CLI wrapper around the normalized detection engine. It is read-only and
// emits one JSON action plan for the explicitly requested, focused, or best
// matching CDP tab.
//
// Usage:
//   node pw-detect.js [tabIdx]

const { chromium } = require('playwright');
const { detectBrowser } = require('./lib/detection-engine');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const preferredTabIdx = process.argv[2] != null && /^\d+$/.test(process.argv[2])
    ? Number(process.argv[2])
    : null;
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const result = await detectBrowser(ctx, preferredTabIdx);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
