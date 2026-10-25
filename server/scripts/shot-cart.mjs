/**
 * 购物车侧栏布局截图
 *
 * 验证三件事：
 *   1. 宽屏（1440）下左侧聊天 + 右侧购物车并排
 *   2. 窄屏（900）下购物车折叠，出现悬浮入口
 *   3. 聊天气泡里**不该再有**菜单明细，只有摘要
 *
 * 用法：node scripts/shot-cart.mjs <宽屏.png> <窄屏.png> <jwt>
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;

const [wide, narrow, jwt] = process.argv.slice(2);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1000',
    '--user-data-dir=' + process.env.TEMP + '\\cdp-cart-' + Date.now(),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function cdpWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  throw new Error('Chrome 没起来');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error('ws: ' + e.message));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
  });
}

try {
  const cdp = await connect(await cdpWs());
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  if (jwt) {
    await cdp.send(
      'Network.setCookie',
      { name: 'mcd_sid', value: jwt, domain: '127.0.0.1', path: '/', httpOnly: true },
      sessionId,
    );
  }

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/#/chat' }, sessionId);
  await sleep(4500);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.text ?? '');
    return r.result?.value;
  };

  // 选「到店自取」，让购物车挂到自取那份（前面已经往里放了两件真商品）
  console.log(
    '选到店:',
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /到店|自取|堂食/.test(x.textContent));
      if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
    })()`),
  );
  await sleep(2000);

  // 布局体检：宽屏下左右是否并排、气泡里是否还有菜单明细
  console.log(
    '\n布局体检:',
    JSON.stringify(
      await evalJs(`(() => {
        const layout = document.querySelector('.chat-layout');
        const slot = document.querySelector('.cart-slot');
        const panel = document.querySelector('.cart-panel');
        const fab = document.querySelector('.cart-fab');
        const bubbleMenu = document.querySelector('.menu, .menu-list');
        const summary = document.querySelector('.menu-summary');
        const cs = slot ? getComputedStyle(slot) : null;
        return {
          有布局容器: !!layout,
          购物车槽存在: !!slot,
          购物车面板存在: !!panel,
          槽宽度: slot ? Math.round(slot.getBoundingClientRect().width) : 0,
          槽display: cs ? cs.display : null,
          悬浮入口display: fab ? getComputedStyle(fab).display : 'none',
          气泡内菜单明细: !!bubbleMenu,
          气泡内摘要: !!summary,
          购物车条目数: document.querySelectorAll('.cp-item, .cart-item').length,
          面板内文本片段: panel ? panel.innerText.slice(0, 160).replace(/\\n/g, ' | ') : null,
        };
      })()`),
      null,
      1,
    ),
  );

  const shot = async (file) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('已保存:', file);
  };

  await shot(wide);

  // 缩到 900 宽，验证折叠成抽屉 + 悬浮入口出现
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await sleep(1200);
  console.log(
    '\n窄屏体检:',
    JSON.stringify(
      await evalJs(`(() => {
        const slot = document.querySelector('.cart-slot');
        const fab = document.querySelector('.cart-fab');
        return {
          槽display: slot ? getComputedStyle(slot).display : null,
          悬浮入口display: fab ? getComputedStyle(fab).display : 'none',
          悬浮入口可见: fab ? fab.getBoundingClientRect().width > 0 : false,
        };
      })()`),
      null,
      1,
    ),
  );
  await shot(narrow);

  cdp.close();
} finally {
  chrome.kill();
}
