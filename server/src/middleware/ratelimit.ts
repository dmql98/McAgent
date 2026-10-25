/**
 * 内存限流：滑动窗口
 * - 全局：IP 30 req/min
 * - chat：10 req/min
 * 自部署防滥用，不引第三方库。
 */
import type { NextFunction, Request, Response } from 'express';
import { RateLimitError } from '../lib/errors.js';

interface Bucket {
  hits: number[];
}

const store = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

function hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  let b = store.get(key);
  if (!b) {
    if (store.size >= MAX_KEYS) {
      // 简单清理：删掉最旧的 1/4
      const keys = [...store.keys()].slice(0, Math.floor(MAX_KEYS / 4));
      for (const k of keys) store.delete(k);
    }
    b = { hits: [] };
    store.set(key, b);
  }
  b.hits = b.hits.filter((t) => t > cutoff);
  if (b.hits.length >= limit) {
    const oldest = b.hits[0] ?? now;
    return { ok: false, retryAfter: Math.ceil((oldest + windowMs - now) / 1000) };
  }
  b.hits.push(now);
  return { ok: true, retryAfter: 0 };
}

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(opts: { limit: number; windowMs?: number; scope?: string }) {
  const windowMs = opts.windowMs ?? 60_000;
  const scope = opts.scope ?? 'global';
  return (req: Request, res: Response, next: NextFunction): void => {
    // 测试环境不限制，避免干扰
    if (process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === '1') {
      next();
      return;
    }
    const key = `${scope}:${clientIp(req)}`;
    const r = hit(key, opts.limit, windowMs);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      next(new RateLimitError(`请求有点多，${r.retryAfter} 秒后再试`));
      return;
    }
    next();
  };
}

/** 定期清理空桶，避免内存缓慢增长 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) {
    b.hits = b.hits.filter((t) => t > now - 60_000);
    if (b.hits.length === 0) store.delete(k);
  }
}, 5 * 60_000);
sweeper.unref?.();

export function resetRateLimitForTest(): void {
  store.clear();
}
