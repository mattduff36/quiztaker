import { chromium } from 'playwright';

const legacyBase = process.env.PARITY_LEGACY_BASE;
const hostedBase = process.env.PARITY_HOSTED_BASE;
if (!legacyBase || !hostedBase) {
  console.log('SKIP headed parity: set PARITY_LEGACY_BASE and PARITY_HOSTED_BASE to run the checklist.');
  process.exit(0);
}

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage();
const checks = [];
try {
  await page.goto(legacyBase, { waitUntil: 'domcontentloaded' });
  checks.push(['legacy dashboard', await page.locator('body').innerText()]);
  await page.goto(hostedBase, { waitUntil: 'domcontentloaded' });
  checks.push(['hosted operations', await page.locator('body').innerText()]);
  const legacyText = checks[0][1];
  const hostedText = checks[1][1];
  for (const label of ['History', 'Learning', 'Docs']) {
    if (!legacyText.includes(label)) throw new Error(`Legacy dashboard is missing ${label}`);
  }
  for (const label of ['History', 'Learning', 'Runbooks']) {
    if (!hostedText.includes(label)) throw new Error(`Hosted Vitriol is missing ${label}`);
  }
  if (!/tab|detect|session/i.test(hostedText)) {
    throw new Error('Hosted operations surface is missing tab, detection, or session controls');
  }
  console.log('Headed parity smoke passed for dashboard, history, and learning labels.');
} finally {
  await browser.close();
}
