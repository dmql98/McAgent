/**
 * 定位路由
 *
 * POST /api/location       提交浏览器定位坐标 → 反查城市/商圈 → 存进记忆
 * GET  /api/location       读当前已存的定位
 * DELETE /api/location     清除定位（隐私：用户随时可删）
 *
 * 为什么要反查而不能直接存坐标：
 * 麦当劳 query-nearby-stores 只吃 { city, keyword }，
 * 坐标对它没用。所以定位这一步的**产出物是城市名**，不是经纬度。
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { BadRequestError } from '../lib/errors.js';
import { getMemoryService } from '../services/memory.service.js';
import { reverseGeocode, normalizeCity } from '../services/geo.service.js';

export const locationRouter = Router();

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /**
   * 可选：前端已知的城市名（比如上次的记忆），传了就不必反查，
   * 省一次外部请求，也避免反查服务抖动导致失败。
   */
  city: z.string().min(1).max(40).optional(),
  /** 可选：前端已知的商圈/地标 */
  district: z.string().min(1).max(60).optional(),
  /** 定位来源，默认 gps */
  source: z.enum(['gps', 'manual']).optional(),
});

locationRouter.post(
  '/',
  requireAuth,
  rateLimit({ limit: 10, scope: 'location' }),
  async (req, res, next) => {
    try {
      const userId = currentUserId(req);
      const parsed = locationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? '定位参数不对');
      }

      const { lat, lng, city, district, source } = parsed.data;

      // 前面已给了城市就不用反查（省一次外部调用）
      let finalCity = city ? normalizeCity(city) : undefined;
      let finalDistrict = district;
      let displayName: string | undefined;

      if (!finalCity || !finalDistrict) {
        const geo = await reverseGeocode(lat, lng);
        if (!finalCity && geo.city) finalCity = geo.city;
        if (!finalDistrict && geo.district) finalDistrict = geo.district;
        displayName = geo.displayName;
      }

      if (!finalCity) {
        /**
         * 反查失败（网络抖动 / 海外坐标 / 服务限流）。
         * 不报错阻塞用户 —— 把坐标存下来，让用户手填城市即可。
         */
        await getMemoryService().setLocation(userId, {
          lat,
          lng,
          ...(finalDistrict ? { district: finalDistrict } : {}),
          ...(source ? { source } : {}),
        });
        res.json({
          ok: true,
          needCity: true,
          message: '定位拿到了，但没查出城市，能告诉我你在哪个城市吗？',
        });
        return;
      }

      await getMemoryService().setLocation(userId, {
        lat,
        lng,
        city: finalCity,
        ...(finalDistrict ? { district: finalDistrict } : {}),
        ...(source ? { source } : {}),
      });

      res.json({
        ok: true,
        needCity: false,
        city: finalCity,
        ...(finalDistrict ? { district: finalDistrict } : {}),
        ...(displayName ? { displayName } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

locationRouter.get('/', requireAuth, (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const snap = getMemoryService().snapshot(userId);
    // 快照里只有 city/keyword，坐标要从原始记忆取
    const mem = getMemoryService().load(userId);
    const loc = mem.habits.location;

    res.json({
      hasLocation: Boolean(loc),
      ...(loc
        ? {
            lat: loc.lat,
            lng: loc.lng,
            ...(loc.city ? { city: loc.city } : {}),
            ...(loc.district ? { district: loc.district } : {}),
            source: loc.source,
            updatedAt: loc.updatedAt,
          }
        : {}),
      // 门店搜索实际会用的两个值，方便前端展示"将按这里找店"
      searchCity: snap?.usualCity ?? null,
      searchKeyword: snap?.usualKeyword ?? null,
    });
  } catch (err) {
    next(err);
  }
});

locationRouter.delete('/', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    await getMemoryService().clearLocation(userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
