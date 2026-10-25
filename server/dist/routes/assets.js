/**
 * 资产路由
 *
 *   GET  /api/assets              卡包券 + 可领券 + 积分
 *   GET  /api/assets/store-coupons 当前门店可用券
 *   POST /api/assets/claim         一键领券（写操作）
 *
 * 全部要求登录：券和积分都挂在用户自己的麦当劳账号下，访客没有。
 */
import { Router } from 'express';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { claimCoupons, getAssets, getStoreCoupons } from '../services/assets.service.js';
export const assetsRouter = Router();
assetsRouter.get('/', requireAuth, async (req, res, next) => {
    try {
        res.json(await getAssets(currentUserId(req)));
    }
    catch (err) {
        next(err);
    }
});
assetsRouter.get('/store-coupons', requireAuth, async (req, res, next) => {
    try {
        res.json(await getStoreCoupons(currentUserId(req)));
    }
    catch (err) {
        next(err);
    }
});
/** 写操作：限得比只读更紧（每人 5 次/分钟） */
assetsRouter.post('/claim', requireAuth, rateLimit({ limit: 5, scope: 'claim' }), async (req, res, next) => {
    try {
        res.json(await claimCoupons(currentUserId(req)));
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=assets.js.map