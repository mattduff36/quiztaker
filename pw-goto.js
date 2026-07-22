const { connectOverCdp } = require('./pw-cdp.js');

const url = process.argv[2];
if (!url) {
  console.error('Usage: node pw-goto.js <url>');
  process.exit(2);
}

async function main() {
  const { browser, page } = await connectOverCdp();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`URL: ${page.url()}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
