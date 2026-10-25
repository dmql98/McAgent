/**
 * 购物车路由
 *
 * 产品背景：菜单从「聊天气泡里的只读卡片」改成「聊天旁边可编辑的清单」。
 * 于是需要一组独立接口，让用户能不经过对话直接增删改。
 *
 * 全部要求登录 —— 购物车要跨刷新存活，访客没有稳定身份可挂。
 * 例外是 GET：访客返回空车，前端不用为"没登录"写两条分支。
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUserId, optionalAuth, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { BadRequestError, NotFoundError, toApiError } from '../lib/errors.js';
import {
  addItem,
  clearCart,
  emptyCart,
  getCart,
  removeItem,
  resolveProduct,
  searchProducts,
  updateItem,
} from '../services/cart.service.js';
import type { Fulfillment } from '../types/contract.js';

export const cartRouter = Router();

const fulfillmentSchema = z.enum(['自取', '外送', '堂食']).optional();

/** GET 用 query 传履约方式；写操作用 body */
const querySchema = z.object({
  fulfillment: z.enum(['自取', '外送', '堂食']).optional(),
  addressId: z.string().min(1).optional(),
});

const addSchema = z.object({
  productId: z.string().min(1, '缺少商品编码'),
  qty: z.number().int().min(1).max(99).optional(),
  spec: z.string().max(120).optional(),
  selected: z.array(z.string().max(40)).max(10).optional(),
  fulfillment: fulfillmentSchema,
  addressId: z.string().min(1).optional(),
  store: z.string().max(120).optional(),
  storeCode: z.string().max(60).optional(),
  beCode: z.string().max(60).optional(),
});

const updateSchema = z.object({
  qty: z.number().int().min(0).max(99).optional(),
  spec: z.string().max(120).optional(),
  selected: z.array(z.string().max(40)).max(10).optional(),
  fulfillment: fulfillmentSchema,
  addressId: z.string().min(1).optional(),
});

const clearSchema = z.object({
  fulfillment: fulfillmentSchema,
});

const fof = (v: unknown): Fulfillment => (v as Fulfillment | undefined) ?? '自取';

/**
 * 单行操作用的履约方式：**没传就是 undefined**，不能像读列表那样默认「自取」。
 *
 * 到店和外送是两份独立购物车。若这里默认成「自取」，
 * 前端漏传一个字段就会拿外送车的行 id 去自取车里改 ——
 * 结果是 404，或者更糟：改到自取车里同名的那一行。服务层会按行 id 反查兜底。
 */
const fofOpt = (v: unknown): Fulfillment | undefined => v as Fulfillment | undefined;

/**
 * 读购物车。
 *
 * 访客返回**空车 + 200**，不是 401。
 * 理由：前端一进页面就要渲染购物车区，401 会把它变成一个红色错误块，
 * 而访客本来就该看到"还没点东西"，不是一个报错。
 */
cartRouter.get('/', optionalAuth, async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const fulfillment = fof(parsed.data.fulfillment);
    const userId = req.userId;
    // 访客/未登录：不查库，直接给空车
    if (!userId) {
      res.json(emptyCart(fulfillment));
      return;
    }
    const cart = await getCart(userId, fulfillment);
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

cartRouter.post('/', requireAuth, rateLimit({ limit: 60, scope: 'cart' }), async (req, res, next) => {
  try {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const d = parsed.data;
    const userId = currentUserId(req);
    const fulfillment = fof(d.fulfillment);

    /**
     * 单价必须由服务端从真实菜单里取，不能信前端传的 price ——
     * 否则改个请求体就能改价。
     */
    const resolved = await resolveProduct(userId, d.productId, fulfillment, {
      ...(d.storeCode ? { storeCode: d.storeCode } : {}),
      ...(d.beCode ? { beCode: d.beCode } : {}),
      ...(d.addressId ? { addressId: d.addressId } : {}),
    });
    if (!resolved) throw new NotFoundError('门店菜单里找不到这件商品，可能已下架');

    const cart = await addItem(userId, resolved.product, {
      ...(d.qty !== undefined ? { qty: d.qty } : {}),
      ...(d.spec ? { spec: d.spec } : {}),
      ...(d.selected ? { selected: d.selected } : {}),
      fulfillment,
      ...(d.addressId ? { addressId: d.addressId } : {}),
      ...(d.store ? { store: d.store } : {}),
      ...(resolved.storeName ? { storeName: resolved.storeName } : {}),
      ...(d.storeCode || resolved.storeCode ? { storeCode: d.storeCode ?? resolved.storeCode } : {}),
      ...(d.beCode || resolved.beCode ? { beCode: d.beCode ?? resolved.beCode } : {}),
    });
    res.json(cart);
  } catch (err) {
    const api = toApiError(err);
    if (api.status < 500) {
      res.status(api.status).json(api.body);
      return;
    }
    next(err);
  }
});

/**
 * 搜索商品（手动加购的搜索框）
 *
 * ⚠️ 必须注册在 `/items/:id` 之前 —— Express 按注册顺序匹配，
 * 否则 `/search` 会被 `:id` 通配吃掉，返回 404「购物车里没有这件商品」。
 */
cartRouter.get('/search', requireAuth, rateLimit({ limit: 40, scope: 'cart' }), async (req, res, next) => {
  try {
    const q = z.string().max(60).optional().parse(req.query.q);
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const fulfillment = fof(parsed.data.fulfillment);

    const items = await searchProducts(currentUserId(req), q ?? '', fulfillment, {
      ...(parsed.data.addressId ? { addressId: parsed.data.addressId } : {}),
    });
    res.json({
      items: items.map((p) => ({
        productId: String(p.productId ?? p.code ?? ''),
        name: p.name,
        price: p.price ?? 0,
        ...(p.modifications?.length ? { modifications: p.modifications.slice(0, 6) } : {}),
      })),
    });
  } catch (err) {
    next(err);
  }
});

cartRouter.patch('/items/:id', requireAuth, rateLimit({ limit: 120, scope: 'cart' }), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const d = parsed.data;
    const cart = await updateItem(
      currentUserId(req),
      String(req.params.id),
      {
        ...(d.qty !== undefined ? { qty: d.qty } : {}),
        ...(d.spec !== undefined ? { spec: d.spec } : {}),
        ...(d.selected !== undefined ? { selected: d.selected } : {}),
      },
      {
        ...(fofOpt(d.fulfillment) ? { fulfillment: fofOpt(d.fulfillment)! } : {}),
        ...(d.addressId ? { addressId: d.addressId } : {}),
      },
    );
    res.json(cart);
  } catch (err) {
    const api = toApiError(err);
    if (api.status < 500) {
      res.status(api.status).json(api.body);
      return;
    }
    next(err);
  }
});

cartRouter.delete('/items/:id', requireAuth, async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? '参数不对');
    const cart = await removeItem(currentUserId(req), String(req.params.id), {
      ...(fofOpt(parsed.data.fulfillment) ? { fulfillment: fofOpt(parsed.data.fulfillment)! } : {}),
    });
    res.json(cart);
  } catch (err) {
    const api = toApiError(err);
    if (api.status < 500) {
      res.status(api.status).json(api.body);
      return;
    }
    next(err);
  }
});

/**
 * 清空购物车。
 *
 * 履约方式优先从 query 取。DELETE 带 body 在部分代理/客户端会被丢掉，
 * 而清错一份购物车（把外送车清成到店车）用户毫无感知，代价太大。
 *
 * 什么都没传 → 清空**全部**，不默认「自取」：
 * 用户点「清空」就是要这单消失，不会想到还有一份留着。
 */
cartRouter.delete('/', requireAuth, async (req, res, next) => {
  try {
    const fromQuery = querySchema.safeParse(req.query);
    const fromBody = clearSchema.safeParse(req.body ?? {});

    const fulfillment: Fulfillment | undefined =
      (fromQuery.success ? fromQuery.data.fulfillment : undefined) ??
      (fromBody.success ? fromBody.data.fulfillment : undefined);

    const cart = await clearCart(currentUserId(req), fulfillment);
    res.json(cart);
  } catch (err) {
    next(err);
  }
});
