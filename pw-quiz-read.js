/**
 * Read the current Saba quiz page state and emit JSON to stdout.
 *
 *   node pw-quiz-read.js [--screenshot]
 *
 * Output shape:
 *   {
 *     "mode": "welcome" | "question" | "result" | "unknown",
 *     "qNum": 1..60 | null,
 *     "total": 60,
 *     "stem": "...",
 *     "isMultiSelect": false,
 *     "options": ["A", "B", ...],
 *     "selected": ["B"],
 *     "score": "73.33" | null,
 *     "screenshot": "data/runs/<attempt>/q01.png" | null,
 *     "url": "https://..."
 *   }
 *
 * Also writes the raw visible text + screenshot into the current attempt folder
 * (if one is active via data/runs/current-attempt.txt).
 */
const fs = require('fs');
const path = require('path');
const { connectOverCdp } = require('./pw-cdp.js');
const { attemptDir, currentAttemptId } = require('./quiz-log.js');

const args = process.argv.slice(2);
const wantScreenshot = args.includes('--screenshot') || args.includes('-s');

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
    const state = await page.evaluate(() => {
      function visibleText(root) {
        return (root?.innerText || '').replace(/\u00a0/g, ' ');
      }

      const bodyText = visibleText(document.body);
      const url = location.href;

      const qMatch = bodyText.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
      const isResult = /Thank you for taking the test|Test result/i.test(bodyText);
      const scoreMatch = isResult
        ? bodyText.match(/Test score\s*([\d.]+%?)/i) || bodyText.match(/Score[:\s]+([\d.]+%?)/i)
        : null;
      const isWelcome = /Welcome|Number of questions|Passing score/i.test(bodyText) && /START/i.test(bodyText) && !qMatch;

      const radios = [...document.querySelectorAll('input[type=radio]')];
      const checks = [...document.querySelectorAll('input[type=checkbox]')];
      const inputs = [...radios, ...checks].filter((el) => el.offsetParent !== null || el.checked);

      function labelFor(el) {
        const fromLabels = el.labels && el.labels[0] ? el.labels[0].innerText : '';
        if (fromLabels && fromLabels.trim()) return fromLabels.trim().replace(/\s+/g, ' ');
        if (el.id) {
          const lab = document.querySelector(`label[for="${el.id}"]`);
          if (lab) return (lab.innerText || '').trim().replace(/\s+/g, ' ');
        }
        const parent = el.closest('label');
        if (parent) return (parent.innerText || '').trim().replace(/\s+/g, ' ');
        const next = el.nextElementSibling;
        if (next) return (next.innerText || '').trim().replace(/\s+/g, ' ');
        return '';
      }

      const seen = new Set();
      const options = [];
      const selected = [];
      for (const el of inputs) {
        const label = labelFor(el);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        options.push(label);
        if (el.checked) selected.push(label);
      }

      const isMultiSelect =
        !!qMatch &&
        (checks.length > 0 ||
          /Select\s+(the\s+)?two|Select\s+(the\s+)?three|Choose\s+two|Choose\s+three|two\s+answers/i.test(bodyText));

      let stem = '';
      const candidates = [
        '.question-text',
        '.question-stem',
        '[class*="question"] p',
        '[class*="Question"] p',
        '.qti-itemBody',
        '.assessment-item .qti-prompt',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 10) {
          stem = el.innerText.trim().replace(/\s+/g, ' ');
          break;
        }
      }

      if (!stem) {
        const raw = bodyText.replace(/\r/g, '');
        const m = raw.match(/Fields marked[^\n]*\n([\s\S]*?)(?:\n\s*Question\s+\d+\s+of\s+\d+|\n\s*QUESTION LIST)/i);
        const block = m ? m[1] : '';
        const lines = block
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !options.includes(l))
          .filter((l) => !/^(EXIT|PREVIOUS|NEXT|QUESTION LIST|CLOSE PLAYER|Powered by)/i.test(l));
        stem = lines.slice(0, 4).join(' ').slice(0, 400);
      }

      let mode = 'unknown';
      if (isResult) mode = 'result';
      else if (qMatch) mode = 'question';
      else if (isWelcome) mode = 'welcome';

      return {
        mode,
        qNum: qMatch ? Number(qMatch[1]) : null,
        total: qMatch ? Number(qMatch[2]) : 60,
        stem,
        isMultiSelect,
        options,
        selected,
        score: scoreMatch ? scoreMatch[1].replace('%', '') : null,
        url,
        bodyTextPreview: bodyText.slice(0, 2000),
      };
    });

    let screenshotPath = null;
    const attemptId = currentAttemptId();
    if (attemptId) {
      const dir = attemptDir(attemptId);
      if (wantScreenshot || state.mode === 'question') {
        const name =
          state.mode === 'question' && state.qNum != null
            ? `q${String(state.qNum).padStart(2, '0')}.png`
            : `${state.mode}-${Date.now()}.png`;
        screenshotPath = path.join(dir, name);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        if (state.mode === 'question' && state.qNum != null) {
          fs.writeFileSync(
            path.join(dir, `q${String(state.qNum).padStart(2, '0')}.txt`),
            state.bodyTextPreview || '',
          );
        }
      }
    }

    const out = { ...state, screenshot: screenshotPath };
    delete out.bodyTextPreview;
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
