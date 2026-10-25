const { chromium } = require('playwright-core');
const JWT = process.argv[2];
const HASH = process.argv[3] || '#/overview';
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';

(async () => {
  console.log('launch...');
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'mcd_sid', value: JWT, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => console.log('REQ-FAIL:', r.url().slice(0, 110), r.failure()?.errorText));

  console.log('goto...');
  await page.goto('http://127.0.0.1:3000/' + HASH, { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log('goto done');
  await page.waitForTimeout(2500);
  const h = await page.locator('h2').first().textContent().catch(() => '(none)');
  const text = await page.locator('#app').innerText().catch(() => '');
  console.log('h2 =', h);
  console.log('text len =', text.length);
  console.log('text 前 400:', text.slice(0, 400).replace(/\n+/g, ' | '));
  await browser.close();
  console.log('closed');
})();
