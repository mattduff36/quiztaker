const { connectOverCdp } = require('./pw-cdp.js');

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    console.log(text);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
