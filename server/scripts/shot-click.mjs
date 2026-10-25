/**
 * 交互式截图：注入登录态 → 点击「麦乐送」→ 截图地址区
 *
 * 用法：
 *   node scripts/shot-click.mjs <url> <out.png> <jwt> <selectorText> [waitMs]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;

const [url, out, jwt, clickText = '', waitMs = '3500', clickText2 = ''] = process.argv.slice(2);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,1100',
    '--user-data-dir=' + process.env.TEMP + '\\cdp2-' + Date.now(),
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

  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(Number(waitMs));

  const doClick = async (text) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const els = [...document.querySelectorAll('button, .link-btn, label')];
          const hit = els.find(b => b.textContent.includes(${JSON.stringify(text)}));
          if (!hit) return 'NOT_FOUND';
          hit.click();
          return 'CLICKED';
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    console.log('点击[' + text + ']:', r.result?.value);
    await sleep(2200);
  };

  if (clickText) await doClick(clickText);
  if (clickText2) await doClick(clickText2);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('已保存:', out);
  cdp.close();
} finally {
  chrome.kill();
}
