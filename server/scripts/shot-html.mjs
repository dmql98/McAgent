/**
 * 静态 HTML 文档渲染截图
 *
 * 用法：node scripts/shot-html.mjs <html路径> <out前缀> [宽]
 * 输出：<out前缀>-full.png（整页长图）+ <out前缀>-fold.png（首屏）
 *
 * 只做一件事：把本地 HTML 打开，等字体和 SVG 都画完，截两张图。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9362;

const [htmlPath, outPrefix, wArg] = process.argv.slice(2);
if (!htmlPath || !outPrefix) {
  console.error('用法: node scripts/shot-html.mjs <html路径> <out前缀> [宽]');
  process.exit(1);
}

const WIDTH = Number(wArg ?? 1440);
const HEIGHT = 1000;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--user-data-dir=' + process.env.TEMP + '\\cdp-html-' + Date.now(),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function cdpWs() {
  for (let i = 0; i < 80; i++) {
    try {
      /**
       * 必须连 **page** target，不能连 /json/version 给的 browser target ——
       * browser target 上不存在 Page / Runtime 域，调用会直接报
       * "Page.enable wasn't found"。这个坑很隐蔽，报错信息也不提 target 的事。
       */
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  throw new Error('Chrome 没起来（没找到 page target）');
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const ws = await connect(await cdpWs());
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');

  const url = pathToFileURL(resolve(htmlPath)).href;
  await send(ws, 'Page.navigate', { url });
  await sleep(2200);

  // 量一下页面尺寸，顺便确认 SVG 都渲染出来了
  const m = await send(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const svgs = [...document.querySelectorAll('svg.tree-svg')];
      return JSON.stringify({
        h: document.documentElement.scrollHeight,
        w: document.documentElement.scrollWidth,
        svgCount: svgs.length,
        svgSizes: svgs.map(s => {
          const b = s.getBoundingClientRect();
          return { w: Math.round(b.width), h: Math.round(b.height) };
        }),
      });
    })()`,
    returnByValue: true,
  });
  const info = JSON.parse(m.result.value);
  console.log('页面信息：', JSON.stringify(info));

  // 首屏
  const fold = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outPrefix}-fold.png`, Buffer.from(fold.data, 'base64'));

  // 整页长图
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: info.h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);
  const full = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${outPrefix}-full.png`, Buffer.from(full.data, 'base64'));

  console.log(`已输出：${outPrefix}-full.png (${WIDTH}×${info.h})`);
  ws.close();
  chrome.kill();
}

main().catch((e) => {
  console.error('截图失败：', e.message);
  chrome.kill();
  process.exit(1);
});
