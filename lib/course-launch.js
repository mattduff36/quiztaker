// Follow a selected Saba course launch in the existing browser, retaining its
// originating tab for result verification. No synthetic completion writes.
const { PATCH_OPEN } = require('./cert-status');
const launchedCourses = new WeakMap();

function courseId(address) {
  try { return decodeURIComponent(address).match(/cours[0-9a-z]+/i)?.[0] || null; } catch { return null; }
}

function sabaContext(address) {
  try {
    const url = new URL(address);
    return url.searchParams.get('context_id') || url.searchParams.get('contextid');
  } catch { return null; }
}

async function launchSelectedCourse(page) {
  if (/^https:\/\/hpi-external\.sabacloud\.com\/.*\/content-player/i.test(page.url())) {
    const matches=page.context().pages().filter(tab=>tab!==page && sabaContext(tab.url())===sabaContext(page.url())
      && /^https:\/\/content-[a-z0-9-]+\.sabacloud\.com\/content\/rcs\/remote_frameset/i.test(tab.url()));
    if(matches.length===1) return matches[0];
  }
  if (!/^https:\/\/hpi-external\.sabacloud\.com\/.*\/learningeventdetail[;/]/i.test(page.url())) return page;
  const control = page.getByRole('button', { name: /^(?:continue|launch)$/i }).filter({ visible: true });
  if (await control.count() !== 1 || !await control.isEnabled()) return page;
  launchedCourses.set(page, courseId(page.url()));
  await page.evaluate(PATCH_OPEN);
  const popup = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
  await control.click({ timeout: 5000 });
  const opened = await popup;
  if (!opened) return page;
  await opened.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  return opened;
}

function originatingSabaPage(player) {
  const contextId = sabaContext(player.url());
  if (!contextId) return null;
  const matches = player.context().pages().filter(page => page !== player
    && /^https:\/\/hpi-external\.sabacloud\.com\//i.test(page.url()) && sabaContext(page.url()) === contextId);
  const landing = matches.length === 1 ? matches[0] : null;
  if (landing) launchedCourses.set(landing, courseId(landing.url()));
  return landing;
}

async function finishSabaCourse(landing, closePlayer = false) {
  if (!landing || landing.isClosed()) return null;
  if (!/^https:\/\/hpi-external\.sabacloud\.com\//i.test(landing.url())) return null;
  const close = landing.getByRole('button', { name: 'CLOSE PLAYER', exact: true });
  if (closePlayer && await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 5000 });
    const yes = landing.getByRole('button', { name: 'YES', exact: true });
    await yes.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    if (await yes.isVisible()) await yes.click({ timeout: 5000 });
  }
  await landing.waitForURL(url => /\/learningeventdetail[;/]/.test(url.pathname), { timeout: 20000 }).catch(() => {});
  if (!/\/learningeventdetail[;/]/.test(new URL(landing.url()).pathname)) return null;
  const expected = launchedCourses.get(landing);
  if (expected && courseId(landing.url()) !== expected) return null;
  const status = landing.getByText('Successful', { exact: true }).first();
  await status.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (!await status.isVisible()) return null;
  return { status: 'completed', title: (await landing.title()).slice(0,200), evidence: ['Saba course detail shows Successful.'], page: landing };
}

module.exports = { launchSelectedCourse, originatingSabaPage, finishSabaCourse };
