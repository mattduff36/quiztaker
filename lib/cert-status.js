// lib/cert-status.js
//
// Shared helpers for reading a Saba certification landing page. Extracted from
// pw-cert-batch.js so both the batch runner and the dashboard's status CLI
// (pw-cert-status.js) use the exact same DOM logic. Roster reads expand any
// collapsed requirement modules first because Saba removes their course rows
// from the DOM while collapsed. Course-evaluation prompts are dismissed before
// expansion so their modal overlay cannot intercept the module-toggle click.
//
// All functions take/return plain data so they can be called from any script
// that already has a Playwright `page` / `ctx` (browser context) in hand.

const PATCH_OPEN = () => {
  if (window.__openPatched) return;
  const orig = window.open.bind(window);
  window.open = function (url) { return orig(url, '_blank'); };
  window.__openPatched = true;
};

// Extract a certification id (crtfy...) from any Saba URL variant, including
// ones with a mid-path `;spf-url=` segment.
function extractCertId(url) {
  const m = (url || '').match(/crtfy[0-9a-z]+/i);
  return m ? m[0] : null;
}

// Build a canonical navigable landing URL from a cert id. learnerId defaults to
// the value used throughout this project but can be overridden.
function buildCertUrl(certId, learnerId = 'persn000000003617677') {
  return `https://hpi-external.sabacloud.com/Saba/Web_spf/HPI/app/me/ledetail/${certId}?learnerId=${learnerId}&context=undefined&forceEnhanced=true`;
}

// Prefer a tab already on a ledetail page; otherwise the first non-player tab;
// otherwise the first tab. Never returns a SCORM player tab if avoidable.
function getLandingTab(ctx) {
  const pages = ctx.pages();
  for (const p of pages) if (/ledetail/i.test(p.url())) return p;
  for (const p of pages) if (!/content-na2prd|remote_frameset/i.test(p.url())) return p;
  return pages[0];
}

// Dismiss Saba's post-course "Evaluate this course?" prompt without opting in
// to the evaluation. The prompt's markup varies, so identify its visible text,
// locate the nearest dialog-like ancestor, and prefer an explicit close control
// before safe negative actions such as "Not now" or "No thanks".
async function dismissCourseEvaluationDialog(page) {
  const result = await page.evaluate(() => {
    function isVisible(element) {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0;
    }

    function normalizedText(element) {
      return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }

    const message = [...document.querySelectorAll('body *')]
      .filter((element) =>
        isVisible(element) &&
        /evaluate this course\s*\?/i.test(normalizedText(element)))
      .sort((left, right) => normalizedText(left).length - normalizedText(right).length)[0];
    if (!message) return { state: 'not-present' };

    const dialogSelector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      'trq-dialog',
      'trq-modal',
      '[class*="dialog"]',
      '[class*="modal"]',
    ].join(', ');
    let dialog = message.closest(dialogSelector);
    for (let current = message; !dialog && current && current !== document.body; current = current.parentElement) {
      const controls = current.querySelectorAll('button, [role="button"]');
      if (controls.length > 0 && normalizedText(current).length < 3000) dialog = current;
    }
    if (!dialog) return { state: 'blocked', reason: 'dialog-container-not-found' };

    const controls = [...dialog.querySelectorAll('button, [role="button"]')]
      .filter(isVisible);
    function controlLabel(control) {
      const iconShape = control.querySelector('[shape]')?.getAttribute('shape') || '';
      return [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        normalizedText(control),
        typeof control.className === 'string' ? control.className : '',
        iconShape,
      ].filter(Boolean).join(' ');
    }

    const closeControl = controls.find((control) =>
      /\b(close|dismiss)\b|trq-icon-close|(?:^|\s)close(?:\s|$)/i.test(controlLabel(control)));
    const negativeControl = controls.find((control) =>
      /^(no(?:,)? thanks|not now|maybe later|cancel|no|×)$/i.test(normalizedText(control)));
    const dismissControl = closeControl || negativeControl;
    if (!dismissControl) return { state: 'blocked', reason: 'dismiss-control-not-found' };

    const label = controlLabel(dismissControl);
    dismissControl.click();
    return { state: 'dismissed', label };
  });

  if (result.state === 'not-present') return false;
  if (result.state === 'blocked') {
    throw new Error(`Course evaluation prompt blocked module expansion: ${result.reason}`);
  }

  await page.waitForFunction(() => {
    function isVisible(element) {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0;
    }
    return ![...document.querySelectorAll('body *')].some((element) =>
      isVisible(element) &&
      /evaluate this course\s*\?/i.test(
        (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
      ));
  }, null, { timeout: 5000 });
  return true;
}

// Expand every collapsed requirement module. Returning from a course commonly
// resets these cards to their collapsed state, which removes the enclosed
// action buttons from the DOM. Re-query after each click because Angular
// replaces the header component while animating it.
async function expandCollapsedModules(page) {
  const selector = '.module-wrapper trq-icon[role="button"][aria-expanded="false"]';
  let expandedCount = 0;

  for (let pass = 0; pass < 20; pass++) {
    await dismissCourseEvaluationDialog(page);
    const previousCount = await page.locator(selector).count();
    const toggle = page.locator(selector).first();
    if (previousCount === 0) break;

    await toggle.click();
    expandedCount++;
    await page.waitForFunction(
      ({ selector, previousCount }) =>
        document.querySelectorAll(selector).length < previousCount,
      { selector, previousCount },
      { timeout: 5000 },
    ).catch(() => {});
  }

  if (expandedCount > 0) {
    await page.waitForFunction(() => {
      const modules = [...document.querySelectorAll('.module-wrapper')];
      return modules.every((module) => {
        const toggle = module.querySelector('trq-icon[role="button"][aria-expanded]');
        if (!toggle || toggle.getAttribute('aria-expanded') !== 'true') return true;
        const content = module.querySelector('.module-content-container');
        return !content || (
          content.childElementCount > 0 &&
          content.getBoundingClientRect().height > 0
        );
      });
    }, null, { timeout: 5000 }).catch(() => {});
  }

  return expandedCount;
}

// Read the recommended-courses roster from a landing page. In addition to the
// visible status/action, annotate sequence/prerequisite locks so planners do
// not mistake a disabled VIEW control for a launchable course.
async function readCourseList(page) {
  await expandCollapsedModules(page);
  return await page.evaluate(() => {
    const rows = [];
    const seenTitles = new Set();
    const pageText = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
    const prerequisiteProgress = [...pageText.matchAll(
      /Prerequisite\s+(\d+)[\s\S]{0,120}?Required\s+\(Complete[^)]*\)\s+(\d+)\s*\/\s*(\d+)/gi,
    )].map((match) => ({
      label: `Prerequisite ${match[1]}`,
      completed: Number(match[2]),
      required: Number(match[3]),
    }));
    const incompletePrerequisites = prerequisiteProgress.filter((item) => item.completed < item.required);

    for (const b of document.querySelectorAll('button')) {
      const t = (b.title || '').trim();
      const m = t.match(/^(Launch|View|Print certificate for)\s+(?:WBT\s+)?(.+?)\s*$/i);
      if (!m) continue;
      const courseTitle = m[2].trim();
      if (seenTitles.has(courseTitle)) continue;
      seenTitles.add(courseTitle);
      let row = b;
      for (let i = 0; i < 15 && row; i++) {
        if (row.innerText && /Successful|In Progress|Registered|Not Started|Failed/i.test(row.innerText)) break;
        row = row.parentElement;
      }
      const rowText = row?.innerText || '';
      const status = /Successful/i.test(rowText) ? 'Successful' :
                     /In Progress/i.test(rowText) ? 'In Progress' :
                     /Pending Registration/i.test(rowText) ? 'Pending Registration' :
                     /Assigned On/i.test(rowText) ? 'Assigned' :
                     /Registered/i.test(rowText) ? 'Registered' :
                     /Failed/i.test(rowText) ? 'Failed' : 'Unknown';
      const action = /^Print certificate/i.test(t) ? 'CERT' : /^View/i.test(t) ? 'VIEW' : 'LAUNCH';
      const actionControl = b.closest('trq-splitbutton, [aria-disabled], .trq-aria-disabled');
      const isActionDisabled = !!(
        b.disabled ||
        b.getAttribute('aria-disabled') === 'true' ||
        actionControl?.getAttribute('aria-disabled') === 'true' ||
        actionControl?.classList.contains('trq-aria-disabled')
      );
      const module = b.closest('.module-wrapper');
      const moduleText = (module?.innerText || '').replace(/\s+/g, ' ').trim();
      const sequenceNotice = moduleText.match(
        /This certification requires you to follow a predefined learning sequence\.[^.]*previous module in the sequence\./i,
      )?.[0] || '';
      const moduleHeading = moduleText.match(
        /^(.*?Required\s+\(Complete[^)]*\)\s+\d+\s*\/\s*\d+)/i,
      )?.[1] || '';
      const targetKind = /^View CERTIFICATION/i.test(t) ? 'certification' :
                         /^View COURSE/i.test(t) ? 'class' :
                         /Exam\/Test/i.test(rowText) ? 'assessment' : 'wbt';
      const isNestedTarget = targetKind === 'certification' || targetKind === 'class';
      const isPrerequisiteBlocked = isActionDisabled && (
        incompletePrerequisites.length > 0 ||
        !!sequenceNotice
      );
      const isBlocked = isPrerequisiteBlocked || (action === 'VIEW' && isNestedTarget);
      const blockedReason = isPrerequisiteBlocked
        ? 'prerequisites-incomplete'
        : isNestedTarget && action === 'VIEW'
          ? 'nested-learning-requirement'
          : null;
      const blockingEvidence = [];
      if (moduleHeading) blockingEvidence.push(moduleHeading);
      if (sequenceNotice) blockingEvidence.push(sequenceNotice);
      for (const prerequisite of incompletePrerequisites) {
        blockingEvidence.push(`${prerequisite.label}: ${prerequisite.completed}/${prerequisite.required} complete`);
      }
      rows.push({
        title: courseTitle,
        status,
        action,
        buttonTitle: t,
        targetKind,
        isActionDisabled,
        isBlocked,
        blockedReason,
        blockingEvidence: [...new Set(blockingEvidence)].slice(0, 5),
      });
    }
    return rows;
  });
}

// Read the certification title + overall path percentage from a landing page.
// Returns { certTitle, pathPct }. Best-effort; fields may be null.
async function readCertMeta(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    // The path percentage renders as e.g. "66%" near a "% Path Completed" label.
    const pctMatch = text.match(/(\d{1,3})%\s*\n?\s*(?:In Progress|Acquired|Completed)/i) ||
                     text.match(/(\d{1,3})%\s*Path Completed/i);
    const pathPct = pctMatch ? Number(pctMatch[1]) : null;
    // Title: first non-trivial heading-ish line. Saba puts the cert name high up.
    let certTitle = null;
    const h = document.querySelector('h1, h2, [class*="title"]');
    if (h && h.innerText) certTitle = h.innerText.trim().slice(0, 200);
    return { certTitle, pathPct };
  });
}

module.exports = {
  PATCH_OPEN,
  extractCertId,
  buildCertUrl,
  getLandingTab,
  dismissCourseEvaluationDialog,
  expandCollapsedModules,
  readCourseList,
  readCertMeta,
};
