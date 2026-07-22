// lib/page-probe.js
//
// Produces a normalized, versioned fingerprint for a browser page. The same
// probe feeds detection, learning captures, replay tests, and strategy stats.

const { createHash } = require('crypto');

const PROBE_SCHEMA_VERSION = 1;

function classifyUrl(url = '') {
  if (/login3\.id\.hp\.com|\/login(?:[/?]|$)/i.test(url)) return 'session-dead';
  if (/content-na2prd|remote_frameset/i.test(url)) return 'scorm-player';
  if (/\/app\/content-player\?/i.test(url)) return 'content-player';
  if (/ledetail[;/]/i.test(url)) return 'cert-landing';
  if (/learningeventdetail\/cours/i.test(url)) return 'class-detail';
  if (/socialtenantngx|wise|support\.hp\.com/i.test(url)) return 'external-tool';
  return 'other';
}

function normalizeText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function fingerprintFor(probe) {
  const stable = {
    schemaVersion: probe.schemaVersion,
    urlKind: probe.urlKind,
    host: probe.host,
    path: probe.path,
    scorm: probe.scorm,
    hasSlickQuiz: probe.hasSlickQuiz,
    hasAssessmentShell: probe.hasAssessmentShell,
    hasActivityRows: probe.hasActivityRows,
    hasDocumentContent: probe.hasDocumentContent,
    inputKinds: probe.inputKinds,
    buttonLabels: (probe.buttons || []).map((button) => button.aria || button.title || button.text).slice(0, 30),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

async function probePage(page, tabIdx = 0) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const parsedUrl = (() => {
    try { return new URL(url); } catch { return null; }
  })();

  const state = await page.evaluate(() => {
    function textOf(element) {
      return (element?.innerText || element?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function walkFrames(win, result = { scorm: null, slickQuiz: false, frameCount: 0, frames: [] }) {
      try {
        result.frameCount += win.frames.length;
        if (win.API_1484_11) result.scorm = result.scorm || '2004';
        if (win.API) result.scorm = result.scorm || '1.2';
        if (win.quizJSON && Array.isArray(win.quizJSON.questions)) result.slickQuiz = true;
        result.frames.push({
          name: win.name || '',
          url: win.location.href,
          accessible: true,
          textPreview: textOf(win.document.body).slice(0, 500),
        });
      } catch (error) {
        result.frames.push({ accessible: false, error: error.message });
      }
      try {
        for (let index = 0; index < win.frames.length; index++) walkFrames(win.frames[index], result);
      } catch {}
      return result;
    }

    const text = textOf(document.body);
    const frameState = walkFrames(window);
    const inputs = [...document.querySelectorAll('input')];
    const questionMatch = text.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
    const activityRows = [...document.querySelectorAll('.activity-list-item, [class*="activity-list-item"]')];
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
      .map((element) => ({
        text: textOf(element).slice(0, 120),
        title: element.getAttribute('title') || '',
        aria: element.getAttribute('aria-label') || '',
        visible: !!element.offsetParent,
      }))
      .filter((button) => button.text || button.title || button.aria)
      .slice(0, 120);
    const hasAssessmentShell = (
      /Remaining Attempts Confirmation|Number of questions|Passing score|Thank you for taking the test|Test score/i.test(text) ||
      !!questionMatch ||
      inputs.filter((input) => /radio|checkbox/i.test(input.type)).length > 1
    );
    const hasDocumentContent = (
      !!document.querySelector('embed[type="application/pdf"], iframe[src*=".pdf"], object[type="application/pdf"]') ||
      /view this document|scroll to (?:the )?end/i.test(text)
    );
    const attemptsMatch = text.match(/(?:Remaining\s+Attempts|Attempts\s+remaining)\s*:?\s*(\d+)/i);
    const passingMatch = text.match(/Passing\s+score\s*:?\s*(\d+)\s*%?/i);

    return {
      textPreview: text.slice(0, 1200),
      scorm: frameState.scorm,
      hasSlickQuiz: frameState.slickQuiz,
      frameCount: frameState.frameCount,
      frames: frameState.frames.slice(0, 30),
      hasAssessmentShell,
      assessment: hasAssessmentShell ? {
        remainingAttempts: attemptsMatch ? Number(attemptsMatch[1]) : null,
        passingScore: passingMatch ? Number(passingMatch[1]) : null,
      } : null,
      hasActivityRows: activityRows.some((row) => textOf(row).length > 0),
      hasDocumentContent,
      question: questionMatch ? {
        current: Number(questionMatch[1]),
        total: Number(questionMatch[2]),
      } : null,
      inputKinds: [...new Set(inputs.map((input) => input.type || 'text'))].sort(),
      counts: {
        buttons: buttons.length,
        inputs: inputs.length,
        radios: inputs.filter((input) => input.type === 'radio').length,
        checks: inputs.filter((input) => input.type === 'checkbox').length,
      },
      buttons,
    };
  }).catch((error) => ({ error: error.message }));

  const probe = {
    schemaVersion: PROBE_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    tabIdx,
    title,
    url,
    urlKind: classifyUrl(url),
    host: parsedUrl?.host || '',
    path: parsedUrl?.pathname || '',
    ...state,
  };
  probe.fingerprint = fingerprintFor(probe);
  return probe;
}

module.exports = {
  PROBE_SCHEMA_VERSION,
  classifyUrl,
  fingerprintFor,
  normalizeText,
  probePage,
};
