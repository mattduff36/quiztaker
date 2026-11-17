// Follow a selected Saba course launch in the existing browser, retaining its
// originating tab for result verification. No synthetic completion writes.
const launchedCourses = new WeakMap();
const protectedPages = new WeakSet();

// The history panel can contain old Successful attempts while the current
// registration is In Progress. Only the current enrollment header is proof.
async function currentCourseSuccessful(page) {
  return page.locator('[class*="course--detail__thirdRow__enrollmentStatus__text"]')
    .filter({visible:true}).evaluateAll(nodes => nodes.length===1 && nodes[0].textContent.trim()==='Successful');
}

function sabaAddress(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && /^(?:hpi-external|content-na2prd0004-na2hp)\.sabacloud\.com$/i.test(url.hostname);
  } catch { return false; }
}

// Installed only on the selected page, and retained on its later documents.
function scopedPopupProtection() {
  const allowed = address => {
    try {
      const url = new URL(address, location.href);
      return url.protocol === 'https:' && /^(?:hpi-external|content-na2prd0004-na2hp)\.sabacloud\.com$/i.test(url.hostname);
    } catch { return false; }
  };
  if (!allowed(location.href) || window.__vitriolCourseOpen) return;
  const original = window.open.bind(window);
  window.open = function(url, ...args) {
    return allowed(url) ? original(url, '_blank') : original(url, ...args);
  };
  window.__vitriolCourseOpen = true;
}

async function protectSabaPopups(page) {
  if (!sabaAddress(page.url())) return;
  if (!protectedPages.has(page)) {
    await page.addInitScript(scopedPopupProtection);
    protectedPages.add(page);
  }
  await page.evaluate(scopedPopupProtection);
}

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
  launchedCourses.set(page, courseId(page.url()));
  if (await currentCourseSuccessful(page)) return page;
  const continuing = page.getByRole('button', {name:/^continue$/i}).filter({visible:true});
  const control = await continuing.count() ? continuing : page.getByRole('button', {name:/^launch$/i}).filter({visible:true});
  if (await control.count() !== 1 || !await control.isEnabled()) return page;
  await protectSabaPopups(page);
  const popup = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
  await control.click({ timeout: 5000 });
  const opened = await popup;
  if (!opened) return page;
  await opened.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await protectSabaPopups(opened);
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

async function finishSabaCourse(landing, closePlayer = false, player = landing, requireCourseIdentity = false) {
  if (!landing || landing.isClosed()) return null;
  if (!/^https:\/\/hpi-external\.sabacloud\.com\//i.test(landing.url())) return null;
  const expected = launchedCourses.get(landing) || courseId(landing.url());
  if (requireCourseIdentity && !expected) return null;
  if (closePlayer) {
    for (const tab of [...new Set([player, landing])]) {
      if (!tab || tab.isClosed() || !sabaAddress(tab.url())) continue;
      if (/\/learningeventdetail[;/]/i.test(tab.url()) && await currentCourseSuccessful(tab)) continue;
      for (const frame of tab.frames()) {
        if (!sabaAddress(frame.url())) continue;
        const closePlayer = frame.getByRole('button', {name:/^close player$/i}).filter({visible:true});
        const close = await closePlayer.count() ? closePlayer : frame.getByRole('button', {name:/^exit$/i})
          .or(frame.getByRole('link', {name:/^exit$/i})).filter({visible:true});
        if (await close.count() !== 1 || !await close.isEnabled()) continue;
        await close.click({timeout:5000});
        if (tab.isClosed()) break;
        for (const confirmation of [...new Set([frame,tab.mainFrame()])]) {
          if(tab.isClosed())break;
          if(confirmation.isDetached())continue;
          const yes = confirmation.getByRole('button', {name:/^yes$/i}).filter({visible:true});
          await yes.waitFor({state:'visible',timeout:1000}).catch(() => {});
          if(tab.isClosed())break;
          if(confirmation.isDetached())continue;
          if (await yes.count() === 1 && await yes.isVisible()) {await yes.click({timeout:5000});break;}
        }
        break;
      }
    }
  }
  await landing.waitForURL(url => /\/learningeventdetail[;/]/.test(url.pathname), { timeout: 20000 }).catch(() => {});
  if (!/\/learningeventdetail[;/]/.test(new URL(landing.url()).pathname)) return null;
  if (expected && courseId(landing.url()) !== expected) return null;
  const status=landing.locator('[class*="course--detail__thirdRow__enrollmentStatus__text"]').filter({visible:true});
  await status.filter({hasText:/^Successful$/}).waitFor({state:'visible',timeout:15000}).catch(()=>{});
  if (!await currentCourseSuccessful(landing)) return null;
  return { status: 'completed', title: (await landing.title()).slice(0,200), evidence: ['Saba course detail shows Successful.'], page: landing };
}

module.exports = { launchSelectedCourse, originatingSabaPage, finishSabaCourse, protectSabaPopups, sabaAddress, currentCourseSuccessful };
