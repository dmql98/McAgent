/**
 * 布局诊断截图
 *
 * 用法：node scripts/shot-diagnose.mjs <out.png> <jwt>
 * 只做一件事：进 /#/chat，量一遍关键元素的位置尺寸，然后截图。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;

const [out, jwt] = process.argv.slice(2);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    '--user-data-dir=' + process.env.TEMP + '\\cdp-diag-' + Date.now(),
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

  const probe = await evalJs(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top),
        display: cs.display, flex: cs.flex, height: cs.height, overflow: cs.overflow,
      };
    };
    return {
      视口: [innerWidth, innerHeight],
      chatLayout: box('.chat-layout'),
      chatWrap: box('.chat-wrap'),
      chatScroll: box('.chat-scroll'),
      composer: box('.composer'),
      composerInput: box('.composer-input'),
      cartSlot: box('.cart-slot'),
      cartPanel: box('.cart-panel'),
      layout父级: (() => {
        const el = document.querySelector('.chat-layout');
        if (!el || !el.parentElement) return null;
        const p = el.parentElement;
        const r = p.getBoundingClientRect();
        return { tag: p.tagName, cls: p.className, w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      根节点: (() => {
        const el = document.querySelector('.chat-layout');
        let cur = el, chain = [];
        while (cur && chain.length < 6) {
          const cs = getComputedStyle(cur);
          const r = cur.getBoundingClientRect();
          chain.push({ cls: cur.className || cur.tagName, h: Math.round(r.height), display: cs.display, height: cs.height });
          cur = cur.parentElement;
        }
        return chain;
      })(),
    };
  })()`);

  console.log(JSON.stringify(probe, null, 1));

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('已保存:', out);
  cdp.close();
} finally {
  chrome.kill();
}
