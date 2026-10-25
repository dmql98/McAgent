/**
 * 记忆路由：GET /api/memory · DELETE /api/memory/:key
 */
import { Router } from 'express';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { NotFoundError } from '../lib/errors.js';
import { getMemoryService } from '../services/memory.service.js';

export const memoryRouter = Router();

memoryRouter.get('/', requireAuth, (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const svc = getMemoryService();
    const memory = svc.load(userId);
    const snap = svc.snapshot(userId);
    const loc = memory.habits.location;

    res.json({
      cards: svc.toCards(userId),
      updatedAt: memory.updatedAt,
      privacyNote: '这些只存在你的账号里，你随时可以删。',
      /**
       * 定位摘要。
       *
       * 前端每次刷新记忆面板都顺带知道"要不要提示用户开定位"，
       * 省一次 GET /api/location 往返。
       */
      location: {
        hasLocation: Boolean(loc),
        ...(loc ? { city: loc.city ?? null, district: loc.district ?? null, source: loc.source } : {}),
        searchCity: snap?.usualCity ?? null,
        searchKeyword: snap?.usualKeyword ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

memoryRouter.delete('/:key', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const rawKey = req.params.key;
    const key = decodeURIComponent(Array.isArray(rawKey) ? (rawKey[0] ?? '') : (rawKey ?? ''));
    if (!key) throw new NotFoundError('没指定要删什么');

    const ok = await getMemoryService().deleteEntry(userId, key);
    if (!ok) throw new NotFoundError('没找到这条记忆，可能已经删了');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
