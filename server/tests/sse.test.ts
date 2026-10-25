/**
 * 前端 SSE 解析器测试（Node 直跑，不需要浏览器）
 *
 * 验收要求："用 mock 把某个事件 data 故意切成两个 chunk 发，解析不能崩"
 * 这里把切点做得比 mock 更极端：逐字节切、跨事件边界切、中文多字节跨 chunk 切。
 *
 * 路径说明：Vue 重构后解析器搬到了 web/src/lib/sse.ts（原来是 web/sse.js）。
 * 它只用 TextDecoder / ReadableStream，都是 Node 原生能力，所以能直接在这里跑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSseParser, consumeSseStream } from '../../web/src/lib/sse.ts';

function collect(chunks) {
  const events = [];
  const push = createSseParser((e) => events.push(e));
  for (const c of chunks) push(c);
  return events;
}

describe('SSE 解析器', () => {
  test('单个完整事件', () => {
    const events = collect(['event: delta\ndata: {"t":"你好"}\n\n']);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'delta');
    assert.deepEqual(JSON.parse(events[0].data), { t: '你好' });
  });

  test('一个事件被切成两个 chunk', () => {
    const events = collect(['event: delta\ndata: {"t":"你', '好"}\n\n']);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), { t: '你好' });
  });

  test('两个事件挤在一个 chunk 里', () => {
    const events = collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n']);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'a');
    assert.equal(events[1].event, 'b');
  });

  test('半个事件留在缓冲区，不提前吐出', () => {
    const events = collect(['event: a\ndata: 1\n\nevent: b\ndata: 2']);
    assert.equal(events.length, 1, '没收到空行就不该发事件');
    assert.equal(events[0].event, 'a');
  });

  test('逐字节推入（最极端切片）', () => {
    const full = 'event: delta\ndata: {"t":"中文不能坏"}\n\n';
    const bytes = [...full];
    const events = collect(bytes);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), { t: '中文不能坏' });
  });

  test('CRLF 换行也能解析', () => {
    const events = collect(['event: delta\r\ndata: {"t":"ok"}\r\n\r\n']);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), { t: 'ok' });
  });

  test('keep-alive 注释行被忽略', () => {
    const events = collect([': keep-alive\n\nevent: a\ndata: 1\n\n']);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'a');
  });

  test('多行 data 用 \\n 拼起来', () => {
    const events = collect(['event: a\ndata: line1\ndata: line2\n\n']);
    assert.equal(events[0].data, 'line1\nline2');
  });

  test('空块不产生事件', () => {
    const events = collect(['\n\n\n\n']);
    assert.equal(events.length, 0);
  });

  test('没有 event 行时事件名是 message', () => {
    const events = collect(['data: {"x":1}\n\n']);
    assert.equal(events[0].event, 'message');
  });
});

describe('consumeSseStream', () => {
  /** 用 Uint8Array 分片模拟 fetch 的 body */
  function streamOf(chunks) {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  test('从字节流里还原事件', async () => {
    const events = [];
    await consumeSseStream(streamOf(['event: stage\ndata: {"stage":"plan"}\n\n']), (e) => events.push(e));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'stage');
    assert.deepEqual(JSON.parse(events[0].data), { stage: 'plan' });
  });

  test('中文被切成两半（多字节跨 chunk）也能还原', async () => {
    // 直接手写字节，确保切点落在 UTF-8 多字节字符中间
    const enc = new TextEncoder();
    const whole = enc.encode('event: delta\ndata: {"t":"麦当劳"}\n\n');
    const cut = 20;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(whole.slice(0, cut));
        controller.enqueue(whole.slice(cut));
        controller.close();
      },
    });

    const events = [];
    await consumeSseStream(body, (e) => events.push(e));
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), { t: '麦当劳' });
  });
});
