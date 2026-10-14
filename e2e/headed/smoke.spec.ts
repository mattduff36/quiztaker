import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { localEnvReady } from '../env';

test.beforeEach(() => {
  test.skip(!localEnvReady(), 'SKIP e2e: .env.local is missing database, auth, or helper settings.');
});

test('assisted learner smoke', async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);
  const failures: string[] = [];
  await page.goto('/sign-in');
  console.log('STEP 1. Sign in on this localhost window.');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 8 * 60 * 1000 });

  if (await page.getByRole('link', { name: 'Start setup' }).isVisible().catch(() => false)) {
    console.log(`STEP 2. Pair the repo helper to ${new URL(page.url()).origin}, then leave it running.`);
    await navLink(page, 'Local helper').click();
    await expect(page.getByText('The helper is online and polling securely.')).toBeVisible({ timeout: 8 * 60 * 1000 });
    await navLink(page, 'Operations').click();
  } else {
    console.log('STEP 2. Helper is already paired. Continuing on Operations.');
  }

  await ensureCdp(page, failures);
  if (failures.length) throw new Error(failures.join('\n'));
  const openUrl = page.getByRole('button', { name: 'Open URL', exact: true });
  await expect(openUrl).toBeEnabled({ timeout: 60_000 });
  const suppliedUrl = process.env.SMOKE_OPEN_URL?.trim() || '';
  if (suppliedUrl) {
    await page.getByPlaceholder('https://').fill(suppliedUrl);
    console.log('STEP 3. Using the quiz URL supplied for this run.');
  } else {
    console.log('STEP 3. Paste the new quiz URL into Launch URL. Do not click Open URL. Then press Resume in the Playwright inspector.');
    await page.pause();
  }

  const quizUrl = (await page.getByPlaceholder('https://').inputValue()).trim();
  if (!/^https?:\/\//i.test(quizUrl)) {
    throw new Error('Launch URL is empty. Paste an http(s) quiz URL, then resume the inspector.');
  }
  console.log('STEP 4. Clicking Open URL.');
  await openUrl.click();
  await confirmIfAsked(page);
  if (!await waitForJob(page, 'Open URL', failures, 120_000)) throw new Error(failures.join('\n'));

  console.log('STEP 5. Refreshing tabs and selecting the quiz tab.');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await confirmIfAsked(page);
  if (!await waitForJob(page, 'Refresh', failures, 90_000)) throw new Error(failures.join('\n'));
  await selectQuizTab(page, quizUrl);

  console.log('STEP 6. Clicking Detect.');
  await page.getByRole('button', { name: 'Detect', exact: true }).click();
  await confirmIfAsked(page);
  if (!await waitForJob(page, 'Detect', failures, 3 * 60 * 1000)) throw new Error(failures.join('\n'));

  await runLearner(page, failures);
  await expect(page.getByRole('button', { name: 'End session' })).toBeVisible();
  if (failures.length) throw new Error(failures.join('\n'));
});

function navLink(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name, exact: true });
}

async function ensureCdp(page: Page, failures: string[]): Promise<void> {
  console.log('STEP 2b. Starting Chrome through the helper.');
  const start = page.getByRole('button', { name: 'Start browser', exact: true });
  if (await start.isEnabled().catch(() => false)) {
    await start.click();
    await confirmIfAsked(page);
    await waitForJob(page, 'Start browser', failures, 90_000);
  }
  const connected = page.getByText('CDP connected');
  for (let attempt = 0; attempt < 3 && !await connected.isVisible().catch(() => false); attempt += 1) {
    const check = page.getByRole('button', { name: 'Check CDP', exact: true });
    if (await check.isEnabled().catch(() => false)) {
      await check.click();
      await confirmIfAsked(page);
      await waitForJob(page, 'Check CDP', failures, 60_000);
    }
    if (await connected.isVisible().catch(() => false)) break;
    await page.waitForTimeout(3000);
  }
  failures.splice(0, failures.length, ...failures.filter((failure) => !/ECONNREFUSED|Waiting for helper output/i.test(failure)));
  if (!await connected.isVisible().catch(() => false)) {
    failures.push('Chrome never connected on port 9222. Start browser did not bring CDP up.');
  } else {
    failures.length = 0;
  }
}

async function selectQuizTab(page: Page, quizUrl: string): Promise<void> {
  let host = '';
  try {
    host = new URL(quizUrl).host;
  } catch {
    host = '';
  }
  const tab = page.locator('button.w-full').filter({ hasText: tabNeedle(quizUrl) || host || 'http' }).last();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
}

function tabNeedle(quizUrl: string): string {
  try {
    const url = new URL(quizUrl);
    return url.searchParams.get('curriculumLoId')
      || url.searchParams.get('contextid')
      || url.host;
  } catch {
    return '';
  }
}

async function runLearner(page: Page, failures: string[]): Promise<void> {
  const learn = page.getByRole('button', { name: 'Learn quiz', exact: true });
  const waitingForDetection = page.getByText('No detection snapshot yet.');
  await expect(waitingForDetection).toBeHidden({ timeout: 20_000 });
  const detection = (await page.locator('section').filter({ has: page.getByRole('heading', { name: 'Auto-detect' }) }).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
  console.log(`Detect result: ${detection || 'unavailable'}`);
  await expect(learn).toBeVisible();
  if (await page.getByText('Add LEARNER_API_KEY to enable Learn quiz.').isVisible().catch(() => false)) {
    throw new Error('LEARNER_API_KEY is not loaded. Restart the local app after saving .env.local.');
  }
  if (await page.getByText('Learn quiz does not run on a server-scored assessment.').isVisible().catch(() => false)) {
    console.log('STEP 7. Detect called this a server-scored assessment. Learn quiz will not run, and the test will not submit.');
    await record(page, 'server-assessment', 'Learner refused a server-scored assessment.');
    return;
  }
  if (await learn.isDisabled()) {
    throw new Error(`Learn quiz stayed disabled after Detect. ${detection || 'No detection text was visible.'}`);
  }
  console.log('STEP 7. Clicking Learn quiz, then Confirm and queue. This run will not submit the quiz.');
  await learn.click();
  await confirmIfAsked(page);
  await waitForJob(page, 'Learn quiz', failures, 8 * 60 * 1000);
}

async function confirmIfAsked(page: Page): Promise<void> {
  const confirm = page.getByRole('button', { name: 'Confirm and queue' });
  const appeared = await confirm.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
  if (appeared) {
    console.log('Confirming the plan.');
    await confirm.click();
  }
}

function learnerStoppedSafely(detail: string): boolean {
  return /Learner step \d+:|step-cap|page does not show a pass|Captured quiz view/.test(detail)
    && !/"action"\s*:\s*"submit"/i.test(detail);
}

async function waitForJob(page: Page, label: string, failures: string[], timeout = 90_000): Promise<boolean> {
  const header = page.getByText(/^Job /).last();
  const before = (await header.textContent().catch(() => '')) || '';
  const inProgress = /· (queued|dispatched|running)/.test(before);
  try {
    if (before && !inProgress) await expect(header).not.toHaveText(before, { timeout: Math.min(timeout, 30_000) });
    await expect(header).toHaveText(/· (completed|failed|cancelled)/, { timeout });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Job did not finish';
    failures.push(`${label}: ${detail}`);
    await record(page, label, detail);
    return false;
  }
  const text = await header.textContent() || '';
  if (/· failed/.test(text)) {
    const detail = await page.locator('pre').last().innerText().catch(() => 'Job failed');
    if (label === 'Learn quiz' && learnerStoppedSafely(detail)) {
      console.log(`STEP 8. Learn quiz finished without submitting. ${detail.slice(0, 300)}`);
      await record(page, 'learn-quiz', detail);
      return true;
    }
    failures.push(`${label}: ${detail.slice(0, 500)}`);
    await record(page, label, detail);
    return false;
  }
  return true;
}

async function record(page: Page, label: string, detail: string): Promise<void> {
  mkdirSync('test-results/smoke', { recursive: true });
  const safe = label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  await page.screenshot({ path: `test-results/smoke/${safe}.png`, fullPage: true }).catch(() => undefined);
  const body = await page.locator('body').innerText().catch(() => '');
  writeFileSync(`test-results/smoke/${safe}.txt`, `${detail}\n\n${body.slice(0, 4000)}\n`);
}
