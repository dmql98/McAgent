const { chromium } = require('playwright-core');
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'mcd_sid', value: process.argv[2], domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:3000/' + process.argv[3], { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: process.argv[4], fullPage: false });
  console.log('saved', process.argv[4]);
  await b.close();
})();
