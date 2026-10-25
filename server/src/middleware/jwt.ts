/**
 * 会话校验中间件
 * 从 httpOnly Cookie 取 JWT，挂 req.userId。
 */
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { verifyJwt } from '../services/auth.service.js';
import { UnauthorizedError } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const cfg = loadConfig();
    const raw = req.cookies?.[cfg.cookieName] as string | undefined;
    if (!raw) throw new UnauthorizedError('请先登录');
    req.userId = verifyJwt(raw);
    next();
  } catch (err) {
    next(err);
  }
}

/** 可选登录：有则挂 userId，无则放行（访客用） */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const cfg = loadConfig();
    const raw = req.cookies?.[cfg.cookieName] as string | undefined;
    if (raw) {
      try {
        req.userId = verifyJwt(raw);
      } catch {
        /* 访客路径：忽略无效会话 */
      }
    }
  } finally {
    next();
  }
}

export function currentUserId(req: Request): string {
  if (!req.userId) throw new UnauthorizedError('请先登录');
  return req.userId;
}
