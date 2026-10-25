const { chromium } = require('playwright-core');
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await b.newContext();
  await ctx.addCookies([{ name: 'mcd_sid', value: process.argv[2], domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
  await p.goto('http://127.0.0.1:3000/#/overview', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await b.close();
})();
