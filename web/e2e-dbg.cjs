const { chromium } = require('playwright-core');
const JWT = process.argv[2];
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'mcd_sid', value: JWT, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/') || r.status() >= 400) console.log(r.status(), u.replace('http://127.0.0.1:3000', ''));
  });
  await page.goto('http://127.0.0.1:3000/#/overview', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  const cookies = await ctx.cookies();
  console.log('cookies:', cookies.map((c) => `${c.name}@${c.domain}${c.path}`).join(', ') || '(none)');
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  });
  console.log('/api/me from page:', JSON.stringify(me));
  await browser.close();
})();
