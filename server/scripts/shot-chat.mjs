/**
 * 完整交互截图：选外送 → 发消息 → 等回复 → 截图
 *
 * 用法：
 *   node scripts/shot-chat.mjs <out.png> <jwt> <fulfillment> <message>
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;

const [out, jwt, fulf = '外送', message = '两个人预算80想吃辣的'] = process.argv.slice(2);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,1200',
    '--user-data-dir=' + process.env.TEMP + '\\cdp3-' + Date.now(),
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
  await sleep(3500);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result?.value;
  };

  // 1. 选履约方式
  if (fulf === '外送') {
    console.log('选外送:', await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('麦乐送'));
      if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
    })()`));
    await sleep(2500);
  }

  // 2. 填消息并发送
  console.log('发消息:', await evalJs(`(() => {
    const inp = document.querySelector('.composer-input');
    if (!inp) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(message)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'FILLED';
  })()`));
  await sleep(600);

  console.log('点发送:', await evalJs(`(() => {
    const b = document.querySelector('.btn-send');
    if (!b) return 'NO_BTN';
    b.click(); return 'SENT';
  })()`));

  // 3. 等回复出现（最多 60s）
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const done = await evalJs(`(() => document.querySelectorAll('.confirm-bar, .total').length > 0 || document.querySelector('.delivery-note') ? 'YES' : 'NO')()`);
    if (done === 'YES') {
      console.log(`回复已到（${(i + 1) * 1.5}s）`);
      break;
    }
  }
  await sleep(1500);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('已保存:', out);
  cdp.close();
} finally {
  chrome.kill();
}
