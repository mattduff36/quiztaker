/**
 * Select answer(s) on the current Saba quiz question by label text.
 * Does NOT advance — use pw-quiz-next.js after this.
 *
 * Usage:
 *   node pw-quiz-pick.js "Exact Option Label"
 *   node pw-quiz-pick.js "First Label" "Second Label"        # multi-select
 *   node pw-quiz-pick.js --contains "substring"              # partial match
 *   node pw-quiz-pick.js --clear                             # uncheck everything
 *
 * Exits non-zero if any requested label could not be matched.
 */
const { connectOverCdp } = require('./pw-cdp.js');

function normalize(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  const picks = [];
  let partial = false;
  let clear = false;
  for (const a of args) {
    if (a === '--contains') {
      partial = true;
    } else if (a === '--clear') {
      clear = true;
    } else {
      picks.push(a);
    }
  }

  if (!clear && picks.length === 0) {
    console.error('Usage: node pw-quiz-pick.js "Label A" ["Label B"]');
    process.exit(2);
  }

  const { browser, page } = await connectOverCdp();
  try {
    const result = await page.evaluate(
      ({ picks, partial, clear }) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].filter(
          (el) => el.offsetParent !== null || el.checked,
        );
        const rows = inputs.map((el) => {
          const lab =
            (el.labels && el.labels[0] && el.labels[0].innerText) ||
            el.closest('label')?.innerText ||
            el.nextElementSibling?.innerText ||
            '';
          return { el, label: lab.trim().replace(/\s+/g, ' ') };
        });

        if (clear) {
          const cleared = [];
          for (const r of rows) {
            if (r.el.checked) {
              r.el.click();
              cleared.push(r.label);
            }
          }
          return { cleared, matched: [], missed: [] };
        }

        const matched = [];
        const missed = [];
        for (const want of picks) {
          const wn = norm(want);
          let row = rows.find((r) => norm(r.label) === wn);
          if (!row && partial) row = rows.find((r) => norm(r.label).includes(wn));
          if (!row && want.length >= 10) row = rows.find((r) => norm(r.label).includes(wn));
          if (row) {
            if (!row.el.checked) row.el.click();
            matched.push(row.label);
          } else {
            missed.push(want);
          }
        }
        return { matched, missed, allOptions: rows.map((r) => r.label) };
      },
      { picks, partial, clear },
    );

    console.log(JSON.stringify(result, null, 2));
    if (!clear && result.missed && result.missed.length) process.exit(3);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
