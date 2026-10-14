import { expect, test } from '@playwright/test';
import { localEnvReady } from '../env';

const pages = ['/', '/helper', '/history', '/learning', '/docs', '/settings', '/download'];
const anonymousRoutes = [
  '/api/operations/actions',
  '/api/jobs',
  '/api/plans',
  '/api/plans/11111111-1111-4111-8111-111111111111/confirm',
];

test.beforeEach(() => {
  test.skip(!localEnvReady(), 'SKIP e2e: .env.local is missing database, auth, or helper settings.');
});

test('sign-in page renders the Vitriol form', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to Vitriol' })).toBeVisible();
  await expect(page.getByLabel('Authorized email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('unsigned pages redirect to sign-in', async ({ page }) => {
  for (const path of pages) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in/);
  }
});

test('learner proposal route rejects an anonymous caller', async ({ request }) => {
  const response = await request.post('/api/helper/jobs/11111111-1111-4111-8111-111111111111/proposal', {
    data: { snapshot: { text: 'Question 1' } },
  });
  expect(response.status()).toBe(401);
});

test('anonymous mutating routes reject a missing origin and a missing session', async ({ request, baseURL }) => {
  for (const path of anonymousRoutes) {
    const missingOrigin = await request.post(path, { data: {} });
    expect(missingOrigin.status(), path).toBe(403);

    const missingSession = await request.post(path, {
      data: {},
      headers: { Origin: baseURL || 'http://127.0.0.1:4010' },
    });
    expect(missingSession.status(), path).toBe(401);
  }
});
