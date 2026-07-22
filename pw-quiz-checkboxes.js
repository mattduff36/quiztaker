/** Dump visible checkbox / multi-select state on current Saba quiz page (CDP). */
const { connectOverCdp } = require('./pw-cdp.js');

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
    const rows = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const add = (el, label, checked) => {
        const key = `${label}|${checked}`;
        if (!label || seen.has(key)) return;
        seen.add(key);
        out.push({ label: label.trim().slice(0, 120), checked });
      };

      document.querySelectorAll('input[type="checkbox"]').forEach((n) => {
        const lab =
          n.labels?.[0]?.innerText ||
          n.getAttribute('aria-label') ||
          n.closest('label')?.innerText ||
          '';
        add(n, lab, !!n.checked);
      });

      document.querySelectorAll('[role="checkbox"]').forEach((n) => {
        const lab =
          n.getAttribute('aria-label') ||
          n.closest('label')?.innerText ||
          n.parentElement?.innerText ||
          '';
        const c =
          n.getAttribute('aria-checked') === 'true' ||
          n.classList.contains('selected') ||
          n.getAttribute('data-selected') === 'true';
        add(n, lab, c);
      });

      return out;
    });
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
