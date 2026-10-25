/**
 * 认证路由
 *
 * 路径严格对齐 docs/contract.md（冻结 v1.0）：
 *   POST   /api/auth/login     → authRouter
 *   POST   /api/auth/logout    → authRouter
 *   DELETE /api/auth/unbind    → authRouter
 *   GET    /api/me             → meRouter   ← 注意：不在 /api/auth 下
 *   PUT    /api/profile        → meRouter   ← 注意：不在 /api/auth 下
 *
 * 契约里登录/退出/解绑带 `/auth` 前缀，而 me/profile 在根 `/api` 下。
 * 两个 router 分开导出，由 index.ts 分别挂载到 `/api/auth` 和 `/api`。
 */
import { Router } from 'express';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import {
  getUser,
  login,
  setAutoConfirm,
  toProfile,
  unbind,
} from '../services/auth.service.js';
import { getMemoryService } from '../services/memory.service.js';
import { getStarSign } from '../services/knowledge.service.js';
import { getDb } from '../db/index.js';
import type { LoginResponse, MeResponse } from '../types/contract.js';

export const authRouter = Router();

/** 契约路径在 `/api` 根下：GET /api/me、PUT /api/profile */
export const meRouter = Router();

const loginSchema = z.object({ token: z.string().min(20, 'Token 看起来不完整').max(4000) });

function cookieOptions() {
  const cfg = loadConfig();
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cfg.nodeEnv === 'production',
    path: '/',
    maxAge: cfg.jwtTtlSeconds * 1000,
  };
}

authRouter.post('/login', rateLimit({ limit: 10, scope: 'login' }), async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Token 格式不对');
    }
    const cfg = loadConfig();
    const result = await login(parsed.data.token.trim());

    res.cookie(cfg.cookieName, result.jwt, cookieOptions());

    // 首次登录 → 初始化记忆库（冷启动，profile 留空）
    await getMemoryService().ensureInitialized(result.userId);

    const body: LoginResponse = {
      ok: true,
      userId: result.userId,
      isNew: result.isNew,
      needOnboarding: result.needOnboarding,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  const cfg = loadConfig();
  res.clearCookie(cfg.cookieName, { path: '/' });
  res.json({ ok: true });
});

authRouter.delete('/unbind', requireAuth, async (req, res, next) => {
  try {
    unbind(currentUserId(req));
    const cfg = loadConfig();
    res.clearCookie(cfg.cookieName, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const row = getUser(userId);
    /**
     * 用户行不存在 = 已经解绑/删号，但 JWT 还没过期。
     * 这种情况必须回 401 而不是 400，否则前端会当成"参数错误"卡在中间态，
     * 既不跳登录页也无法重试。401 才能触发前端清 cookie + 回登录。
     */
    if (!row) throw new UnauthorizedError('账号已解绑，请重新粘贴 Token');
    const body: MeResponse = {
      userId,
      profile: toProfile(row),
      hasToken: Boolean(row.token_enc),
      needOnboarding: !row.nickname,
      autoConfirm: row.auto_confirm === 1,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

const profileSchema = z.object({
  nickname: z.string().min(1).max(30).optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式应为 YYYY-MM-DD')
    .optional(),
  taboo: z.array(z.string().min(1).max(20)).max(20).optional(),
  autoConfirm: z.boolean().optional(),
});

meRouter.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    // 同 GET /api/me：用户已被解绑但 JWT 残留 → 401，让前端回登录页
    if (!getUser(userId)) throw new UnauthorizedError('账号已解绑，请重新粘贴 Token');
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? '资料格式不对');
    }
    const { nickname, birthday, taboo, autoConfirm } = parsed.data;

    const db = getDb();
    const now = Date.now();

    if (nickname !== undefined) {
      db.prepare('UPDATE users SET nickname = ?, updated_at = ? WHERE user_id = ?').run(
        nickname.trim(),
        now,
        userId,
      );
    }
    if (birthday !== undefined) {
      const d = new Date(`${birthday}T00:00:00`);
      if (Number.isNaN(d.getTime())) throw new BadRequestError('生日不是有效日期');
      const sign = getStarSign(d);
      db.prepare(
        'UPDATE users SET birthday = ?, star_sign = ?, updated_at = ? WHERE user_id = ?',
      ).run(birthday, sign.name, now, userId);
    }
    if (taboo !== undefined) {
      db.prepare('UPDATE users SET taboo = ?, updated_at = ? WHERE user_id = ?').run(
        JSON.stringify(taboo),
        now,
        userId,
      );
    }
    if (autoConfirm !== undefined) {
      setAutoConfirm(userId, autoConfirm);
    }

    // 同步进记忆库（三连问即记忆冷启动）
    const mem = getMemoryService();
    await mem.applyProfile(userId, { nickname, birthday, taboo });

    const row = getUser(userId)!;
    res.json({ ok: true, profile: toProfile(row), needOnboarding: !row.nickname });
  } catch (err) {
    next(err);
  }
});
