const { chromium } = require('playwright');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';

async function connectOverCdp() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('No browser contexts found. Is the CDP browser running?');
  }
  const context = contexts[0];
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  return { browser, context, page };
}

module.exports = { connectOverCdp, CDP_URL };
