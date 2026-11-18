// Read and activate the same exact Saba activity identity, including title
// attributes when the rendered label is truncated. Never pick a partial match.
function activityRows(request) {
  const items = [...document.querySelectorAll('div.activity-list-item[role="button"]')];
  const rows = items.map((el, idx) => {
    const titleEl = el.querySelector('span.activity-cont.activity-title')
      || el.querySelector('span.activity-cont') || el.querySelector('span.activity-title');
    const title = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    const text = (el.innerText || '').trim();
    const success = !!el.querySelector('[title="Completed Successfully" i], [aria-label="Completed Successfully" i], .trq-icon-success');
    const failed = /unsuccessful|failed|not completed/i.test(text);
    const status = !failed && (success || /\b(?:Completed|Successful)\b/i.test(text)) ? 'Completed'
      : /In Progress/i.test(text) ? 'In Progress'
      : /Not started|Pending|Registered/i.test(text) ? 'Pending' : 'Unknown';
    return { idx, title, status, ...(el.id ? { domId: el.id } : {}) };
  });
  if (!request) return rows;
  const matches = rows.filter(row => row.title && row.title === request.title);
  if (matches.length > 1) return 'ambiguous';
  if (!matches.length) return 'not-found';
  const row = matches[0];
  if (request.domId && request.domId !== row.domId) return 'target-changed';
  const el = items[row.idx];
  if (!el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    || el.closest('[aria-disabled=true], .trq-aria-disabled, [disabled]')) return 'unavailable';
  el.click();
  return 'clicked';
}

async function readActivities(page) {
  return page.evaluate(activityRows);
}

async function clickActivity(page, activity, maxMs = 10000) {
  const observed = typeof activity === 'string' ? { title: activity } : activity;
  const deadline = Date.now() + maxMs;
  do {
    const result = await page.evaluate(activityRows, observed);
    if (result !== 'not-found' || Date.now() >= deadline) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
}

function containerResult(activities, finalActivities, results, parentSuccessful) {
  const failures = results.filter(result => !result.ok).map(result => ({
    title: result.title, reason: result.reason || result.status || 'activity-completion-unverified',
  }));
  for (const activity of activities) {
    const matches = finalActivities.filter(row => row.title === activity.title);
    if ((matches.length !== 1 || matches[0].status !== 'Completed')
      && !failures.some(failure => failure.title === activity.title)) {
      failures.push({ title: activity.title, reason: matches.length > 1 ? 'ambiguous-activity' : 'activity-completion-unverified' });
    }
  }
  const completed = activities.filter(activity => !failures.some(failure => failure.title === activity.title)).length;
  if (!activities.length) failures.push({ title: 'container', reason: 'no-activities-observed' });
  if (!parentSuccessful) failures.push({ title: 'container', reason: 'parent-course-success-unverified' });
  // The wrapper is part of the requested outcome, not a success-shaped 0/0.
  return { completed: completed + (parentSuccessful ? 1 : 0), total: activities.length + 1, failures };
}

module.exports = { readActivities, clickActivity, containerResult };
