// lib/class-status.js
//
// Shared helpers for reading a Saba course/class detail page. These pages list
// one or more launchable activities beneath `/me/learningeventdetail/cours...`.
// The dashboard detector and selected-activity batch runner use the same DOM
// fingerprints so the picker matches what automation will attempt.

function getClassDetailTab(ctx) {
  const pages = ctx.pages();
  for (const page of pages) {
    if (/\/me\/learningeventdetail\/cours/i.test(page.url())) return page;
  }
  for (const page of pages) {
    if (!/content-na2prd|remote_frameset|\/app\/content-player/i.test(page.url())) return page;
  }
  return pages[0];
}

async function readClassActivities(page) {
  return await page.evaluate(() => {
    const activities = [];
    const seenTitles = new Set();

    for (const button of document.querySelectorAll('button')) {
      const label = (button.getAttribute('aria-label') || button.title || '').trim();
      const launchMatch = label.match(/^Launch for (.+?)\.?$/i);
      const resultsMatch = label.match(/^View results for (.+?)\.?$/i);
      const match = launchMatch || resultsMatch;
      if (!match) continue;

      const title = match[1].replace(/\.$/, '').trim();
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);

      let row = button;
      for (let i = 0; i < 14 && row; i++) {
        const text = row.innerText || '';
        if (
          text.includes(title) &&
          /Completed|Successful|Not evaluated|In Progress|Registered|Failed/i.test(text)
        ) break;
        row = row.parentElement;
      }

      const rowText = row?.innerText || '';
      const status = /Completed|Successful/i.test(rowText) ? 'Completed' :
        /In Progress/i.test(rowText) ? 'In Progress' :
        /Not evaluated/i.test(rowText) ? 'Not evaluated' :
        /Registered/i.test(rowText) ? 'Registered' :
        /Failed/i.test(rowText) ? 'Failed' : 'Unknown';
      const action = launchMatch ? 'LAUNCH' : 'RESULTS';

      activities.push({ title, status, action, buttonLabel: label });
    }

    return activities;
  });
}

async function readClassMeta(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const classLine = lines.findIndex((line) => /^Class\s*\|\s*Course ID:/i.test(line));
    const titleElement = document.querySelector('h1.course--detail__title, h1[class*="course"][class*="title"]');
    const classTitle = titleElement?.innerText?.trim() ||
      (classLine > 0 ? lines[classLine - 1] : document.title.replace(/^Cornerstone Saba:\s*/i, ''));
    const courseIdMatch = text.match(/Course ID:\s*([A-Za-z0-9_-]+)/i);
    const leadingText = lines.slice(0, Math.min(lines.length, classLine + 12)).join(' ');
    const status = /\bSuccessful\b/i.test(leadingText) ? 'Successful' :
      /\bIn Progress\b/i.test(leadingText) ? 'In Progress' :
      /\bRegistered\b/i.test(leadingText) ? 'Registered' : 'Unknown';

    return {
      classTitle,
      courseId: courseIdMatch ? courseIdMatch[1] : null,
      status,
    };
  });
}

module.exports = {
  getClassDetailTab,
  readClassActivities,
  readClassMeta,
};
