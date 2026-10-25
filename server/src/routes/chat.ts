/**
 * 对话路由：POST /api/chat（SSE 流式）
 *
 * 关键点：
 * - 手动写 SSE 帧（event: xxx\ndata: {...}\n\n）
 * - 客户端断开 → 中止下游流水线，不再烧 MCP 额度
 * - 访客每 IP 每日 1 次
 */
import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { BadRequestError, GuestLimitError, toApiError } from '../lib/errors.js';
import { optionalAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { runChat } from '../services/orchestrator.js';
import { getDb } from '../db/index.js';
import type { ChatReply, SseEvent } from '../types/contract.js';
import { loadConfig } from '../config.js';

const log = createLogger('chat');

export const chatRouter = Router();

const chatSchema = z.object({
  message: z.string().min(1, '说点什么吧').max(1000, '一次说太多了'),
  guest: z.boolean().optional(),
  /**
   * 履约方式：对话开局由前端选择。
   * 不传默认「自取」（兼容旧前端）。
   */
  fulfillment: z.enum(['自取', '外送', '堂食']).optional(),
  /** 外送必传：配送地址 ID */
  addressId: z.string().min(1).optional(),
});

function clientIp(req: { headers: Record<string, unknown>; ip?: string; socket: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 访客额度：每 IP 每日 1 次
 * 用 SQLite 计数（重启不丢），失败则放行（不能因计数故障挡住用户）
 */
function consumeGuestQuota(ip: string): { allowed: boolean; used: number; limit: number } {
  const limit = loadConfig().guestDailyLimit;
  try {
    const db = getDb();
    const day = todayIso();
    const row = db
      .prepare('SELECT used FROM guest_usage WHERE ip = ? AND day = ?')
      .get<{ used: number }>(ip, day);
    const used = row?.used ?? 0;
    if (used >= limit) return { allowed: false, used, limit };

    db.prepare(
      `INSERT INTO guest_usage (ip, day, used) VALUES (?, ?, 1)
       ON CONFLICT(ip, day) DO UPDATE SET used = used + 1`,
    ).run(ip, day);

    return { allowed: true, used: used + 1, limit };
  } catch (err) {
    log.warn(`访客计数失败，放行：${(err as Error).message}`);
    return { allowed: true, used: 0, limit };
  }
}

function sseWrite(res: import('express').Response, event: SseEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(payloadOf(event))}\n\n`);
}

function payloadOf(event: SseEvent): unknown {
  switch (event.type) {
    case 'stage':
      return { stage: event.stage, text: event.text };
    case 'delta':
      return { text: event.text };
    case 'reply':
      return event.payload;
    case 'done':
      return { chatId: event.chatId };
    case 'error':
      return { error: event.error, message: event.message };
  }
}

chatRouter.post(
  '/',
  optionalAuth,
  rateLimit({ limit: 10, scope: 'chat' }),
  async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
      res.status(err.status).json(err.toBody());
      return;
    }

    const { message, guest, fulfillment, addressId } = parsed.data;
    const isGuest = Boolean(guest) || !req.userId;

    if (isGuest) {
      const q = consumeGuestQuota(clientIp(req));
      if (!q.allowed) {
        const err = new GuestLimitError();
        res.status(err.status).json(err.toBody());
        return;
      }
    }

    /* ---- SSE 头 ---- */
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const ctrl = new AbortController();
    let closed = false;

    /**
     * 断连检测必须挂在 res 上，不能挂 req。
     *
     * Node 22 / Express 5 里 `req` 的 'close' 表示"请求体读完了"，
     * 在 POST body 被 express.json() 消费完时就立刻触发（实测 0ms）。
     * 若用它当断连信号，closed 会在流水线启动前就变 true，
     * 导致一个事件都发不出去、且 finally 里跳过 res.end() → 连接挂死到反代超时。
     *
     * `res` 的 'close' 才表示响应流终结：要么我们主动 end()，要么客户端真的断了。
     */
    res.on('close', () => {
      if (!closed) {
        closed = true;
        ctrl.abort();
        log.debug('客户端断开，中止流水线');
      }
    });

    // 心跳，防止反代 60s 超时
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    try {
      for await (const event of runChat({
        userId: req.userId ?? null,
        message,
        guest: isGuest,
        signal: ctrl.signal,
        ...(fulfillment ? { fulfillment } : {}),
        ...(addressId ? { addressId } : {}),
      })) {
        if (closed) break;

        // 访客回复加 upsell 标记
        if (event.type === 'reply' && isGuest) {
          (event.payload as ChatReply).upsell = 'login';
        }
        sseWrite(res, event);
      }
    } catch (err) {
      log.error(`对话流异常：${(err as Error).message}`);
      const api = toApiError(err);
      if (!closed) {
        sseWrite(res, {
          type: 'error',
          error: api.body.error,
          message: api.body.message,
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!closed) res.end();
    }
  },
);
