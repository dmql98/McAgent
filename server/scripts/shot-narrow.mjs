/**
 * 窄屏布局诊断
 *
 * 用法：node scripts/shot-narrow.mjs <out.png> <jwt> [width] [height]
 * 验证 <=1100px 时购物车是否变成抽屉、聊天区是否仍占满宽度。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;

const [out, jwt, w = '900', h = '760'] = process.argv.slice(2);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${w},${h}`,
    '--user-data-dir=' + process.env.TEMP + '\\cdp-narrow-' + Date.now(),
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
  await sleep(4000);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.text ?? '');
    return r.result?.value;
  };

  const probe = await evalJs(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), pos: cs.position, transform: cs.transform };
    };
    return {
      视口: [innerWidth, innerHeight],
      chatWrap: box('.chat-wrap'),
      chatScroll: box('.chat-scroll'),
      composer: box('.composer'),
      cartSlot: box('.cart-slot'),
      fab: box('.cart-fab'),
    };
  })()`);

  console.log(JSON.stringify(probe, null, 1));

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('已保存:', out);
  cdp.close();
} finally {
  chrome.kill();
}
