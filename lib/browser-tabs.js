// Live Chromium target identity survives navigation, duplicate titles and tab
// reordering. Never recover a signed target by title or a redacted URL.
'use strict';

async function browserTargetId(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const {targetInfo} = await session.send('Target.getTargetInfo');
    if (!targetInfo?.targetId) throw new Error('The live browser target could not be identified');
    return targetInfo.targetId;
  } finally { await session.detach(); }
}

async function listBrowserTabs(browser) {
  const tabs = [];
  for (const [contextIdx, context] of browser.contexts().entries()) {
    for (const page of context.pages()) {
      const cdpTargetId = await browserTargetId(page);
      const title = await page.title();
      const focus = await page.evaluate(() => ({hasFocus:document.hasFocus(),visibilityState:document.visibilityState}));
      tabs.push({idx:tabs.length,contextIdx,cdpTargetId,title,url:page.url(),...focus});
    }
  }
  return tabs;
}

async function selectBrowserPage(pages, index, expectedId = process.env.VITRIOL_CDP_TARGET_ID) {
  if (!expectedId) {
    if (!pages[index]) throw new Error('The selected browser tab is no longer open');
    return pages[index];
  }
  const matches = [];
  for (const page of pages) if (await browserTargetId(page) === expectedId) matches.push(page);
  if (matches.length !== 1) throw new Error('The selected live browser tab is closed or missing; refresh and inspect again');
  return matches[0];
}

module.exports = {browserTargetId,listBrowserTabs,selectBrowserPage};
