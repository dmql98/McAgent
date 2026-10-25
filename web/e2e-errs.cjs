const { chromium } = require('playwright-core');
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';
const HASHES = process.argv.slice(3);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await b.newContext();
  await ctx.addCookies([{ name: 'mcd_sid', value: process.argv[2], domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.on('response', async (r) => {
    if (r.status() >= 400) {
      let body = '';
      try { body = (await r.text()).slice(0, 160); } catch {}
      console.log(`  [${r.status()}] ${r.request().method()} ${r.url().replace('http://127.0.0.1:3000','')}`);
      console.log(`        ${body}`);
    }
  });
  for (const h of HASHES) {
    console.log(`\n=== ${h} ===`);
    await p.goto('http://127.0.0.1:3000/' + h, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2200);
  }
  await b.close();
})();
