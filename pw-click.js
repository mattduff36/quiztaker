const { connectOverCdp } = require('./pw-cdp.js');

/**
 * Clicks by Playwright selector, role, or visible text (in order).
 * Usage:
 *   node pw-click.js --selector "#id"
 *   node pw-click.js --role button --name "Next"
 *   node pw-click.js --text "Option A"
 */
async function main() {
  const args = process.argv.slice(2);
  const get = flag => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    return args[i + 1] ?? null;
  };

  const selector = get('--selector');
  const role = get('--role');
  const name = get('--name');
  const text = get('--text');

  if (!selector && !(role && name) && !text) {
    console.error(
      'Usage: node pw-click.js --selector <css> | --role <role> --name <name> | --text <substring>',
    );
    process.exit(2);
  }

  const { browser, page } = await connectOverCdp();
  try {
    if (selector) {
      await page.locator(selector).first().click({ timeout: 15000 });
    } else if (role && name) {
      await page.getByRole(role, { name: new RegExp(name, 'i') }).first().click({ timeout: 15000 });
    } else if (text) {
      await page.getByText(text, { exact: false }).first().click({ timeout: 15000 });
    }
    console.log('clicked');
    console.log(`URL: ${page.url()}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
