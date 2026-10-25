/**
 * 菜单路由：GET /api/menu
 *
 * 「全部菜单」页专用。只读，走网关缓存（10 分钟）。
 */
import { Router } from 'express';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { getMenu } from '../services/menu.service.js';

export const menuRouter = Router();

menuRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await getMenu(currentUserId(req)));
  } catch (err) {
    next(err);
  }
});
