/**
 * 截图工具：用 Chrome DevTools Protocol 注入登录 Cookie 后截图。
 *
 * 为什么不用 --screenshot：那个模式无法设置 Cookie，
 * 页面会停在登录页，截不到登录后的真实界面。
 *
 * 用法：
 *   node scripts/shot.mjs <url> <out.png> [cookieValue] [waitMs]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const [url, out, cookieVal = '', waitMs = '4000'] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node scripts/shot.mjs <url> <out.png> [cookieValue] [waitMs]');
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,1100',
    '--user-data-dir=' + process.env.TEMP + '\\cdp-profile-' + Date.now(),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function cdpUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* not ready */
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
    ws.onerror = (e) => reject(new Error('ws error: ' + e.message));
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
  const wsUrl = await cdpUrl();
  const cdp = await connect(wsUrl);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  // 注入登录 cookie（JWT 存在 httpOnly cookie 里）
  if (cookieVal) {
    await cdp.send(
      'Network.setCookie',
      { name: process.env.COOKIE_NAME || 'mcd_sid', value: cookieVal, domain: '127.0.0.1', path: '/', httpOnly: true },
      sessionId,
    );
  }

  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(Number(waitMs));

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('已保存:', out);
  cdp.close();
} finally {
  chrome.kill();
}
