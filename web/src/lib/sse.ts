/**
 * SSE 解析器
 *
 * 手写而不引第三方库的原因：
 * ① 事件格式是本项目自己定的（stage/delta/reply/done/error），不需要通用 EventSource；
 * ② 需要 POST（要带 message body），EventSource 只支持 GET；
 * ③ 需要拿到 HTTP 状态码判断登录失效，EventSource 拿不到。
 */

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * 逐块解析 SSE 字节流。
 *
 * 处理要点：
 * - 网络分片可能把一个 JSON 切成两半 → 必须按 \n\n 缓冲
 * - 服务端可能用 \r\n → 统一替换
 * - 注释行（: keep-alive）直接跳过
 */
export function createSseParser(onMessage: (msg: SseMessage) => void) {
  let buffer = '';

  return function push(chunk: string): void {
    buffer += chunk.replace(/\r\n/g, '\n');

    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');

      if (!block.trim()) continue;

      let event = 'message';
      const dataLines: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // keep-alive 注释
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }

      if (dataLines.length) onMessage({ event, data: dataLines.join('\n') });
    }
  };
}

/**
 * 把 fetch 的 ReadableStream 消费成 SSE 事件序列。
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (msg: SseMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const push = createSseParser(onMessage);

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) push(decoder.decode(value, { stream: true }));
    }
    // 冲掉解码器残留
    const tail = decoder.decode();
    if (tail) push(tail);
  } finally {
    reader.releaseLock();
  }
}
