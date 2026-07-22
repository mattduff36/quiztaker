// start-cdp-browser.js
//
// Launch a *persistent*, non-incognito Chrome for the automation to attach to.
// - Uses the real installed Chrome (channel: 'chrome') so it looks and behaves
//   like your normal browser (bookmarks bar, normal profile UI), not a bare
//   Playwright/incognito window.
// - Runs against a dedicated profile directory under the project
//   (.chrome-cdp-profile) so we never lock or disturb your main Chrome profile
//   (Chrome refuses to open a profile that's already in use).
// - On first launch, seeds that profile with your existing Chrome bookmarks by
//   copying the Bookmarks file from your default Chrome profile, so your quiz
//   sites are one click away. Anything you bookmark in this window persists
//   across runs too.
//
// Env overrides:
//   PLAYWRIGHT_CDP_PORT   debugging port (default 9222)
//   QUIZ_URL              open this URL on launch (default about:blank)
//   CDP_PROFILE_DIR       persistent profile dir (default ./.chrome-cdp-profile)
//   CHROME_SOURCE_PROFILE which real Chrome profile to import bookmarks from
//                         (default "Default"; e.g. "Profile 1")
//   IMPORT_BOOKMARKS=0    skip the bookmark import
//   CHROME_USER_DATA      override the source Chrome "User Data" folder

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PLAYWRIGHT_CDP_PORT || '9222';
const url = process.env.QUIZ_URL || 'about:blank';
const PROFILE_DIR = process.env.CDP_PROFILE_DIR || path.join(__dirname, '.chrome-cdp-profile');
const SOURCE_PROFILE = process.env.CHROME_SOURCE_PROFILE || 'Default';

// Best-effort location of the real Chrome "User Data" folder per platform.
function defaultChromeUserData() {
  if (process.env.CHROME_USER_DATA) return process.env.CHROME_USER_DATA;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// Copy the user's existing bookmarks into our dedicated profile the first time
// we create it. Never overwrites bookmarks the user has added in this profile.
function seedBookmarks() {
  if (process.env.IMPORT_BOOKMARKS === '0') return;
  const destProfile = path.join(PROFILE_DIR, 'Default');
  const destBookmarks = path.join(destProfile, 'Bookmarks');
  if (fs.existsSync(destBookmarks)) return; // already seeded / user has their own

  const srcBookmarks = path.join(defaultChromeUserData(), SOURCE_PROFILE, 'Bookmarks');
  if (!fs.existsSync(srcBookmarks)) {
    console.log(`(no source bookmarks found at ${srcBookmarks}; skipping import)`);
    return;
  }
  try {
    fs.mkdirSync(destProfile, { recursive: true });
    fs.copyFileSync(srcBookmarks, destBookmarks);
    const bak = srcBookmarks + '.bak';
    if (fs.existsSync(bak)) fs.copyFileSync(bak, destBookmarks + '.bak');
    console.log(`Imported bookmarks from ${srcBookmarks}`);
  } catch (e) {
    console.log(`(could not import bookmarks: ${e.message})`);
  }
}

async function launch() {
  seedBookmarks();
  const opts = {
    headless: false,
    viewport: null, // use the real window size, not a fixed viewport
    args: [
      `--remote-debugging-port=${PORT}`,
      '--restore-last-session',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  // Prefer real Chrome so bookmarks/UI look normal; fall back to bundled Chromium.
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch (e) {
    console.log(`(real Chrome unavailable: ${e.message}; falling back to bundled Chromium)`);
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function main() {
  const context = await launch();
  const page = context.pages()[0] || (await context.newPage());

  if (url && url !== 'about:blank') {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  console.log(`CDP: http://127.0.0.1:${PORT}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Page: ${page.url()}`);

  process.on('SIGINT', async () => {
    await context.close().catch(() => {});
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
