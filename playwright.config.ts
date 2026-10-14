import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT || '4010';
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node --import ./scripts/load-root-env.mjs ../../node_modules/next/dist/bin/next dev -p ${port}`,
    cwd: 'apps/web',
    url: `${baseURL}/sign-in`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'headless',
      testMatch: /headless\/.*\.spec\.ts/,
      use: { headless: true },
    },
    {
      name: 'headed',
      testMatch: /headed\/.*\.spec\.ts/,
      timeout: 30 * 60 * 1000,
      use: { headless: false, viewport: { width: 1440, height: 900 } },
    },
  ],
});
