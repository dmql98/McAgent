/**
 * 订单路由：confirm / status / cancel + 外送地址
 * 全部要求登录 —— 访客不能下单，也不能存地址。
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { BadRequestError, toApiError } from '../lib/errors.js';
import { cancelOrder, confirmFromCart, confirmOrder, getOrderStatus } from '../services/order.service.js';
import { createAddress, listAddresses, pickAddress } from '../services/delivery.service.js';

export const ordersRouter = Router();

const confirmSchema = z.object({
  chatId: z.string().min(1),
  /**
   * 可选：一般**不要传**，沿用对话开局选的履约方式。
   * 传了且与对话记录不一致时服务端会拒绝 —— 因为菜单商品编码
   * 是按当时那套场景查的，换场景下不了单。
   */
  fulfillment: z.enum(['自取', '外送', '堂食']).optional(),
  addressId: z.string().min(1).optional(),
});

const addressSchema = z.object({
  city: z.string().min(1, '要填城市'),
  contactName: z.string().min(1, '要填联系人'),
  gender: z.string().optional(),
  phone: z.string().regex(/^1\d{10}$/, '手机号要 11 位纯数字'),
  address: z.string().min(1, '要填地址'),
  addressDetail: z.string().min(1, '要填门牌号'),
});

ordersRouter.post('/confirm', requireAuth, rateLimit({ limit: 10, scope: 'order' }), async (req, res, next) => {
  try {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '缺少 chatId');
    const { chatId, fulfillment, addressId } = parsed.data;
    const result = await confirmOrder(currentUserId(req), chatId, {
      ...(fulfillment ? { fulfillment } : {}),
      ...(addressId ? { addressId } : {}),
    });
    res.json(result);
  } catch (err) {
    const api = toApiError(err);
    if (api.status === 409) {
      res.status(409).json(api.body);
      return;
    }
    next(err);
  }
});

/**
 * 按**当前购物车**下单。
 *
 * 与 /confirm 的区别：/confirm 用的是对话时的菜单快照，
 * 而这里用购物车的当前状态 —— 用户手动删了一项再下单，
 * 必须按删后的算钱，不能按原菜单。
 */
ordersRouter.post('/confirm-cart', requireAuth, rateLimit({ limit: 10, scope: 'order' }), async (req, res, next) => {
  try {
    const parsed = z
      .object({
        fulfillment: z.enum(['自取', '外送', '堂食']).optional(),
        addressId: z.string().min(1).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const result = await confirmFromCart(currentUserId(req), {
      fulfillment: parsed.data.fulfillment ?? '自取',
      ...(parsed.data.addressId ? { addressId: parsed.data.addressId } : {}),
    });
    res.json(result);
  } catch (err) {
    const api = toApiError(err);
    if (api.status === 409 || api.status === 400) {
      res.status(api.status).json(api.body);
      return;
    }
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 外送地址                                                          */
/* ------------------------------------------------------------------ */

/** 地址列表（前端开局选外送时立刻要用） */
ordersRouter.get('/addresses', requireAuth, async (req, res, next) => {
  try {
    const list = await listAddresses(currentUserId(req));
    res.json({ addresses: list, defaultId: list.find((a) => a.isDefault)?.addressId ?? list[0]?.addressId });
  } catch (err) {
    next(err);
  }
});

/** 新建地址。写操作，限流比查询严一点 */
ordersRouter.post(
  '/addresses',
  requireAuth,
  rateLimit({ limit: 5, scope: 'address' }),
  async (req, res, next) => {
    try {
      const parsed = addressSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '地址信息不全');
      const created = await createAddress(currentUserId(req), parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  },
);

/** 校验某个地址当前是否可用（下单前轻量确认） */
ordersRouter.get('/addresses/:id', requireAuth, async (req, res, next) => {
  try {
    const params = req.params as Record<string, string | string[]>;
    const raw = params.id;
    const id = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    if (!id) throw new BadRequestError('缺少地址 ID');
    const addr = await pickAddress(currentUserId(req), id);
    if (!addr) throw new BadRequestError('没找到这个地址');
    res.json(addr);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 订单详情                                                          */
/* ------------------------------------------------------------------ */

ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const params = req.params as Record<string, string | string[]>;
    const raw = params.id;
    const id = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    if (!id) throw new BadRequestError('缺少订单号');
    res.json(await getOrderStatus(currentUserId(req), id));
  } catch (err) {
    next(err);
  }
});

ordersRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const params = req.params as Record<string, string | string[]>;
    const raw = params.id;
    const id = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    if (!id) throw new BadRequestError('缺少订单号');
    res.json(await cancelOrder(currentUserId(req), id));
  } catch (err) {
    next(err);
  }
});
