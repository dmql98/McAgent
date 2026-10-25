/**
 * 截取页面上某个 CSS 选择器对应的元素区域（2x 高清），用来检查局部排版。
 *
 * 用法：node scripts/shot-el.mjs <html路径> <out.png> <选择器>
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT ?? 9371);

const [htmlPath, outPng, selector] = process.argv.slice(2);
if (!htmlPath || !outPng || !selector) {
  console.error('用法: node scripts/shot-el.mjs <html路径> <out.png> <选择器>');
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1400,1000',
    '--user-data-dir=' + process.env.TEMP + '\\cdp-el-' + Date.now(), 'about:blank',
  ],
  { stdio: 'ignore' },
);

async function pageWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  throw new Error('没找到 page target');
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

const targetUrl = await pageWs();
const ws = await new Promise((res, rej) => {
  const w = new WebSocket(targetUrl);
  w.onopen = () => res(w);
  w.onerror = rej;
});

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
await send(ws, 'Page.navigate', { url: pathToFileURL(resolve(htmlPath)).href });
await sleep(2000);

const probe = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'null';
  const b = el.getBoundingClientRect();
  return JSON.stringify({
    x: Math.round(b.x + scrollX),
    y: Math.round(b.y + scrollY),
    w: Math.round(b.width),
    h: Math.round(b.height),
  });
})()`;

const r = await send(ws, 'Runtime.evaluate', { expression: probe, returnByValue: true });
if (r.result.value === 'null') {
  console.error('找不到元素：' + selector);
  ws.close();
  chrome.kill();
  process.exit(1);
}

const box = JSON.parse(r.result.value);
console.log('区域：' + JSON.stringify(box));

/**
 * 视口必须**装得下**目标元素，否则 captureScreenshot 的 clip 会以可视区为界裁掉左右。
 * 之前算宽度只按元素宽度 + 80，遇上元素带外边距/居中布局就会左溢。
 * 现在按"元素右边界 + 左侧留白"取大值，保证整块都在视口里。
 */
const needW = Math.max(box.x + box.w + 60, 1240);
const needH = box.h + 80;

await send(ws, 'Emulation.setDeviceMetricsOverride', {
  width: needW,
  height: needH,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(700);

/* 宽视口生效后元素可能重排（居中布局会右移），重新量一次 */
const r2 = await send(ws, 'Runtime.evaluate', { expression: probe, returnByValue: true });
const box2 = r2.result.value === 'null' ? box : JSON.parse(r2.result.value);

const shot = await send(ws, 'Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: box2.x, y: box2.y, width: box2.w, height: box2.h, scale: 2 },
});
writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log('已输出：' + outPng);

ws.close();
chrome.kill();
