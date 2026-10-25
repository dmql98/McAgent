/**
 * 浏览器端到端检查：逐个面板打开，确认渲染出内容且无控制台报错。
 * 用法：node e2e-check.cjs <jwt>
 */
const { chromium } = require('playwright-core');

const JWT = process.argv[2];
const BASE = 'http://127.0.0.1:3000';
const EXEC = 'C://Users//dmql//AppData//Local//ms-playwright//chromium-1243//chrome-win64//chrome.exe';

const ROUTES = [
  ['#/overview', '总览'], ['#/chat', '对话'], ['#/memory', '记忆'],
  ['#/stores', '门店'], ['#/menu', '菜单'], ['#/nutrition', '营养'],
  ['#/coupons', '优惠券'], ['#/orders', '订单'], ['#/points', '积分'],
  ['#/mall', '商城'], ['#/campaigns', '活动'], ['#/parties', '派对'],
  ['#/addresses', '地址'], ['#/cart', '购物车'], ['#/tools', '工具台'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'mcd_sid', value: JWT, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  let ok = 0;
  for (const [hash, label] of ROUTES) {
    const before = errors.length;
    await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(650);
    const h = (await page.locator('h2').first().textContent().catch(() => '')) || '';
    const text = await page.locator('#app').innerText().catch(() => '');
    const badges = await page.locator('.src').count();
    const bad = errors.length - before;
    const good = text.length > 100 && h.trim().length > 0;
    if (good) ok++;
    console.log(`${good ? '✓' : '✗'} ${label.padEnd(5)} h2=${h.trim().padEnd(9)} 文本${String(text.length).padEnd(5)} 徽标${String(badges).padEnd(3)} 新错误${bad}  ${hash}`);
  }

  console.log(`\n${ok}/${ROUTES.length} 面板正常　控制台错误共 ${errors.length} 条`);
  errors.slice(0, 10).forEach((e) => console.log('  ✗', e.slice(0, 160)));
  await browser.close();
})();
