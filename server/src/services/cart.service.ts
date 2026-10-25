/**
 * 购物车服务
 *
 * 产品变化：菜单从「聊天气泡里的一张只读卡片」变成「聊天旁边的一份可编辑清单」。
 * 于是菜单必须**离开 ChatReply，成为独立状态**，否则：
 *   · 用户手动删了一项，下一次对话又把整份菜单推回来，删了等于白删；
 *   · 用户说「加个薯条」，服务端不知道当前车里有什么，只能重新选品（等于换了一单）。
 *
 * 设计要点：
 *   1. 按 (user_id, fulfillment) 存一份。到店和外送是两套商品编码，
 *      混着放必然出现「按外送菜单选的品，却按到店下单」。
 *   2. 整份购物车存成 JSON 一列：读写永远整体进行，天然保序。
 *   3. 价格存**单价**，小计永远现算。存小计会在改数量时算错。
 *   4. 合计要含外送费 —— 用户看到的「合计」必须是付款金额，
 *      不是商品价（这个坑在外送预算上已经踩过一次）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { callTool } from '../mcp/gateway.js';
import {
  calcDeliveryPrice,
  fulfillmentArgs,
  isDelivery,
  queryDeliveryStores,
} from './delivery.service.js';
import { adaptProducts, adaptStores } from './mcp-adapter.js';
import { loadConfig } from '../config.js';
import type {
  Cart,
  CartItem,
  DeliveryFeeInfo,
  Fulfillment,
  MenuItem,
} from '../types/contract.js';

/** 入车所需的最小商品信息（RawProduct / 搜索结果 / 菜单项都能满足） */
export interface RawProductLite {
  productId?: string;
  id?: string;
  code?: string;
  name: string;
  /** 单价 */
  price?: number;
  originalPrice?: number;
  modifications?: string[];
}

const log = createLogger('cart');

interface CartRow {
  user_id: string;
  fulfillment: string;
  items_json: string;
  store: string | null;
  store_code: string | null;
  be_code: string | null;
  address_id: string | null;
  address_text: string | null;
  updated_at: number;
}

/** 空车。未登录/首次访问都返回它，前端不用区分 */
export function emptyCart(fulfillment: Fulfillment = '自取'): Cart {
  return {
    items: [],
    subtotal: 0,
    total: 0,
    fulfillment,
    count: 0,
    updatedAt: Date.now(),
  };
}

function parseItems(json: string): CartItem[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is CartItem => {
      const it = x as Partial<CartItem>;
      return Boolean(it && typeof it.id === 'string' && typeof it.name === 'string' && typeof it.price === 'number');
    });
  } catch {
    return [];
  }
}

/** 件数：qty 之和 */
function countOf(items: CartItem[]): number {
  return items.reduce((s, it) => s + Math.max(1, Math.floor(it.qty)), 0);
}

/** 商品合计（不含任何费用） */
export function subtotalOf(items: CartItem[]): number {
  const raw = items.reduce((s, it) => s + it.price * Math.max(1, Math.floor(it.qty)), 0);
  return Math.round(raw * 100) / 100;
}

function rowToCart(row: CartRow): Cart {
  const items = parseItems(row.items_json);
  const subtotal = subtotalOf(items);
  return {
    items,
    subtotal,
    total: subtotal,
    fulfillment: (row.fulfillment as Fulfillment) ?? '自取',
    ...(row.store ? { store: row.store } : {}),
    ...(row.store_code ? { storeCode: row.store_code } : {}),
    ...(row.be_code ? { beCode: row.be_code } : {}),
    ...(row.address_id ? { addressId: row.address_id } : {}),
    ...(row.address_text ? { address: row.address_text } : {}),
    count: countOf(items),
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* 读                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按行 id 反查这份行属于哪份购物车。
 *
 * 为什么必须有它：行 id 是 uuid，本身全局唯一。凡是以 `/items/:id` 进来的
 * 修改/删除，都只凭 id 就足以定位到唯一一行，不需要调用方再告诉你履约方式。
 *
 * 反过来，如果接口依赖「调用方必须传 fulfillment」，一旦漏传就会默认成「自取」，
 * 于是拿外送车的 id 去自取车里找 —— 轻则 404「购物车里没有这件商品」，
 * 重则改到两个车碰巧同商品那一行上（到店/外送是两套编码，但同名商品很多），
 * 用户看到的就是「我删了外送的薯条，结果自取那份没了」。
 *
 * 返回 null 表示这个用户压根没有任何购物车。
 */
function findFulfillmentOfItem(
  userId: string,
  itemId: string,
): { fulfillment: Fulfillment; found: boolean } | null {
  const rows = getDb()
    .prepare('SELECT * FROM carts WHERE user_id = ? ORDER BY updated_at DESC')
    .all<CartRow>(userId);
  if (rows.length === 0) return null;

  for (const row of rows) {
    const items = parseItems(row.items_json);
    if (items.some((it) => it.id === itemId)) {
      return { fulfillment: (row.fulfillment as Fulfillment) ?? '自取', found: true };
    }
  }
  // 有这个用户的车，但没有哪份装了这一行
  const first = rows[0]!;
  return { fulfillment: (first.fulfillment as Fulfillment) ?? '自取', found: false };
}

/**
 * 取购物车。
 *
 * 外送场景会**实时算一次价**（配送费随地址/距离变，缓存会算错钱）。
 * 算价失败不报错：购物车还能看能改，只是费用显示成"待确认"。
 */
export async function getCart(
  userId: string | null,
  fulfillment: Fulfillment = '自取',
  opts: { price?: boolean } = {},
): Promise<Cart> {
  if (!userId) return emptyCart(fulfillment);

  const row = getDb()
    .prepare('SELECT * FROM carts WHERE user_id = ? AND fulfillment = ?')
    .get<CartRow>(userId, fulfillment);

  if (!row) return emptyCart(fulfillment);

  const cart = rowToCart(row);
  if (opts.price !== false && isDelivery(fulfillment) && cart.items.length > 0) {
    await applyDeliveryFee(userId, cart);
  }
  return cart;
}

/**
 * 外送费如实算出来填进 cart。
 *
 * 单独抽出来是因为「算价」是多处需要的动作：
 * 读购物车要算、改完购物车要算、下单前还要算一次核对。
 */
async function applyDeliveryFee(userId: string, cart: Cart): Promise<void> {
  if (!cart.storeCode || !cart.beCode || !cart.addressId || cart.items.length === 0) return;
  try {
    const info = await calcDeliveryPrice(userId, {
      storeCode: cart.storeCode,
      beCode: cart.beCode,
      addressId: cart.addressId,
      items: cart.items.map((it) => ({ productCode: it.productId, quantity: Math.max(1, Math.floor(it.qty)) })),
    });
    if (!info) return;

    const fee = Math.round((info.deliveryFee ?? 0) * 100) / 100;
    const packing = Math.round((info.packingFee ?? 0) * 100) / 100;
    const deliveryFee: DeliveryFeeInfo = {
      delivery: fee,
      packing,
      ...(info.minOrder !== undefined ? { minOrder: info.minOrder } : {}),
    };
    cart.deliveryFee = deliveryFee;
    /**
     * 合计 = MCP 返回的实付总额。
     *
     * 为什么不用 subtotal + fee + packing 自己加：
     * MCP 还有满减、券后价等因素，自己加会和订单页对不上。
     * 只有在 MCP 没给 total 时才退回自算。
     */
    cart.total =
      typeof info.total === 'number' && info.total > 0
        ? Math.round(info.total * 100) / 100
        : Math.round((cart.subtotal + fee + packing) * 100) / 100;
  } catch (err) {
    log.warn(`购物车算价失败（保留商品，费用待确认）：${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 写                                                                */
/* ------------------------------------------------------------------ */

function save(userId: string, fulfillment: Fulfillment, cart: Cart): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO carts (user_id, fulfillment, items_json, store, store_code, be_code, address_id, address_text, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, fulfillment) DO UPDATE SET
       items_json = excluded.items_json,
       store = COALESCE(excluded.store, carts.store),
       store_code = COALESCE(excluded.store_code, carts.store_code),
       be_code = COALESCE(excluded.be_code, carts.be_code),
       address_id = COALESCE(excluded.address_id, carts.address_id),
       address_text = COALESCE(excluded.address_text, carts.address_text),
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    fulfillment,
    JSON.stringify(cart.items),
    cart.store ?? null,
    cart.storeCode ?? null,
    cart.beCode ?? null,
    cart.addressId ?? null,
    cart.address ?? null,
    now,
  );
  cart.updatedAt = now;
}

/** 同一商品 + 同一特制 → 合并数量；不同特制 → 新起一行 */
function sameLine(a: CartItem, b: Pick<CartItem, 'productId' | 'spec' | 'selected'>): boolean {
  if (a.productId !== b.productId) return false;
  const sa = [...(a.selected ?? [])].sort().join('|');
  const sb = [...(b.selected ?? [])].sort().join('|');
  return sa === sb && (a.spec ?? '') === (b.spec ?? '');
}

export interface MutateCtx {
  fulfillment?: Fulfillment;
  addressId?: string;
  /** 门店信息（对话选品时带上的，手动加购时可能没有） */
  store?: string;
  storeCode?: string;
  beCode?: string;
  /** 门店名。与 store 等价，只是来源不同（解析商品时顺手拿到的） */
  storeName?: string;
}

/**
 * 加商品。
 *
 * `product` 可以是完整 RawProduct（对话推荐/搜索加购都走这里），
 * 但必须有 productId —— 下单时 MCP 只认编码，没编码的商品加进去也下不了单。
 */
export async function addItem(
  userId: string,
  product: RawProductLite,
  opts: { qty?: number; spec?: string; selected?: string[] } & MutateCtx = {},
): Promise<Cart> {
  if (!userId) throw new BadRequestError('登录后才能用购物车');
  const productId = String(product.productId ?? product.code ?? '').trim();
  if (!productId) {
    /**
     * 没有编码的商品不能进购物车。
     * 直接拒绝比"加进去但下单时失败"好 —— 后者发生在付款前一刻，最伤。
     */
    throw new BadRequestError(`「${product.name}」查不到商品编码，暂时加不进购物车`);
  }

  const fulfillment = opts.fulfillment ?? '自取';
  const cart = await getCart(userId, fulfillment, { price: false });

  const qty = Math.max(1, Math.min(99, Math.floor(opts.qty ?? 1)));
  const selected = opts.selected?.length ? [...opts.selected] : undefined;

  const hit = cart.items.find((it) => sameLine(it, { productId, spec: opts.spec, selected }));
  if (hit) {
    hit.qty = Math.min(99, hit.qty + qty);
  } else {
    const price = Number(product.price ?? 0);
    if (!(price > 0)) throw new BadRequestError(`「${product.name}」价格异常，暂时加不进购物车`);

    const item: CartItem = {
      id: randomUUID(),
      productId,
      name: String(product.name ?? ''),
      price: Math.round(price * 100) / 100,
      qty,
      ...(product.originalPrice !== undefined && product.originalPrice > price
        ? { originalPrice: Math.round(product.originalPrice * 100) / 100 }
        : {}),
      ...(opts.spec ? { spec: opts.spec } : {}),
      ...(selected ? { selected } : {}),
      ...(product.modifications?.length ? { modifications: product.modifications.slice(0, 6) } : {}),
    };
    cart.items.push(item);
  }

  if (opts.store) cart.store = opts.store;
  else if (opts.storeName && !cart.store) cart.store = opts.storeName;
  if (opts.storeCode) cart.storeCode = opts.storeCode;
  if (opts.beCode) cart.beCode = opts.beCode;
  if (opts.addressId) cart.addressId = opts.addressId;

  cart.subtotal = subtotalOf(cart.items);
  cart.total = cart.subtotal;
  cart.count = countOf(cart.items);
  save(userId, fulfillment, cart);

  if (isDelivery(fulfillment)) await applyDeliveryFee(userId, cart);
  return cart;
}

/**
 * 改数量；qty <= 0 等价于删除（前端步进减到 0 时的自然行为）。
 *
 * `ctx.fulfillment` 可以**省略**：省略时按行 id 反查它属于哪份购物车。
 * 这样 `/items/:id` 这类接口就天然安全 —— 漏传履约方式不会改错车。
 */
export async function updateItem(
  userId: string,
  itemId: string,
  patch: { qty?: number; spec?: string; selected?: string[] },
  ctx: MutateCtx = {},
): Promise<Cart> {
  if (!userId) throw new BadRequestError('登录后才能用购物车');

  let fulfillment: Fulfillment;
  if (ctx.fulfillment) {
    fulfillment = ctx.fulfillment;
  } else {
    const located = findFulfillmentOfItem(userId, itemId);
    // 哪里都找不到这一行 → 用它当前所在/默认那份车来报错，报错里的车内容才对得上
    if (!located) throw new NotFoundError('购物车里没有这件商品');
    fulfillment = located.fulfillment;
    if (!located.found) throw new NotFoundError('购物车里没有这件商品');
  }

  const cart = await getCart(userId, fulfillment, { price: false });

  const idx = cart.items.findIndex((it) => it.id === itemId);
  if (idx < 0) throw new NotFoundError('购物车里没有这件商品');

  const it = cart.items[idx]!;
  if (patch.qty !== undefined) {
    const q = Math.floor(patch.qty);
    if (q <= 0) {
      cart.items.splice(idx, 1);
    } else {
      it.qty = Math.min(99, q);
    }
  }
  if (patch.spec !== undefined) {
    if (patch.spec) it.spec = patch.spec;
    else delete it.spec;
  }
  if (patch.selected !== undefined) {
    if (patch.selected.length) it.selected = patch.selected;
    else delete it.selected;
  }

  cart.subtotal = subtotalOf(cart.items);
  cart.total = cart.subtotal;
  cart.count = countOf(cart.items);
  save(userId, fulfillment, cart);

  if (isDelivery(fulfillment)) await applyDeliveryFee(userId, cart);
  return cart;
}

export async function removeItem(
  userId: string,
  itemId: string,
  ctx: MutateCtx = {},
): Promise<Cart> {
  return updateItem(userId, itemId, { qty: 0 }, ctx);
}

/**
 * 清空。
 *
 * `fulfillment` 省略时清空**全部**购物车 —— 不默认成「自取」。
 * 用户点「清空」的意图是「这单我不要了」，不会想到"只清了其中一份，
 * 换个履约方式东西还在"。要只清一份，前端本来就会把履约方式带上。
 */
export async function clearCart(userId: string, fulfillment?: Fulfillment): Promise<Cart> {
  if (!userId) return emptyCart(fulfillment ?? '自取');
  const db = getDb();
  if (fulfillment) {
    db.prepare('DELETE FROM carts WHERE user_id = ? AND fulfillment = ?').run(userId, fulfillment);
  } else {
    db.prepare('DELETE FROM carts WHERE user_id = ?').run(userId);
  }
  return emptyCart(fulfillment ?? '自取');
}

/**
 * 用一次对话生成的菜单**替换**购物车。
 *
 * 为什么是替换而不是合并：
 * 用户说「两个人吃、100 块、不辣」，这是在**重新组一单**，
 * 不是"在原来基础上再加一单"。合并会出现「上一轮的点餐 + 这一轮的点餐」叠一起。
 * 除非用户明确说「再加」，那时走 addItem。
 */
export async function replaceFromMenu(
  userId: string,
  menu: MenuItem[],
  ctx: MutateCtx & { fulfillment: Fulfillment; addressId?: string },
): Promise<Cart> {
  if (!userId) throw new BadRequestError('登录后才能用购物车');
  const fulfillment = ctx.fulfillment ?? '自取';

  const items: CartItem[] = [];
  for (const m of menu) {
    const productId = String(m.productId ?? '').trim();
    if (!productId) {
      log.warn(`菜单项「${m.name}」没有 productId，跳过入车`);
      continue;
    }
    /**
     * MenuItem.price 是**小计**，MenuItem.spec 里带着 "×2"。
     * 入车必须拆成「单价 × 数量」，否则购物车合计会翻倍。
     */
    const qty = parseQty(m.spec) ?? 1;
    const price = qty > 0 ? Math.round((m.price / qty) * 100) / 100 : m.price;

    items.push({
      id: randomUUID(),
      productId,
      name: m.name,
      price,
      qty,
      ...(cleanSpec(m.spec) ? { spec: cleanSpec(m.spec) } : {}),
      ...(m.why ? { why: m.why } : {}),
      ...(m.modifications?.length ? { modifications: m.modifications.slice(0, 6) } : {}),
    });
  }

  const cart: Cart = {
    items,
    subtotal: subtotalOf(items),
    total: 0,
    fulfillment,
    ...(ctx.store ? { store: ctx.store } : {}),
    ...(ctx.storeCode ? { storeCode: ctx.storeCode } : {}),
    ...(ctx.beCode ? { beCode: ctx.beCode } : {}),
    ...(ctx.addressId ? { addressId: ctx.addressId } : {}),
    count: countOf(items),
    updatedAt: Date.now(),
  };
  cart.total = cart.subtotal;

  save(userId, fulfillment, cart);
  if (isDelivery(fulfillment)) await applyDeliveryFee(userId, cart);
  return cart;
}

/** 从 spec 里取 "×2" 的 2 */
export function parseQty(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = /[×xX*]\s*(\d{1,3})/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 去掉 spec 里的 "×2"，只留特制说明 */
export function cleanSpec(spec: string | undefined): string {
  if (!spec) return '';
  return spec
    .replace(/[×xX*]\s*\d{1,3}/g, '')
    .replace(/[·・]\s*[·・]/g, '·')
    .replace(/^\s*[·・]\s*|\s*[·・]\s*$/g, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 按编码解析商品（手动加购用）                                       */
/* ------------------------------------------------------------------ */

/**
 * 从前端只给了 productId 也能加进购物车。
 *
 * 为什么不能只传 productId：购物车要显示名字和**单价**，
 * 而单价绝不能由前端说了算（前端改个数字就能改价）。
 * 所以这里回到 MCP 菜单里按编码查一次真实商品。
 *
 * 带 3 分钟缓存：用户连续点几个加购，不该每次都打一次 MCP。
 */
const productCache = new Map<string, { at: number; products: RawProductLite[] }>();
const PRODUCT_TTL = 3 * 60_000;

async function loadProducts(
  userId: string,
  fulfillment: Fulfillment,
  ctx: { storeCode?: string; beCode?: string; addressId?: string },
): Promise<RawProductLite[]> {
  const key = `${userId}:${fulfillment}:${ctx.storeCode ?? ''}:${ctx.addressId ?? ''}`;
  const hit = productCache.get(key);
  if (hit && Date.now() - hit.at < PRODUCT_TTL) return hit.products;

  const products = await fetchProductsForFulfillment(userId, fulfillment, ctx);
  if (products.length > 0) productCache.set(key, { at: Date.now(), products });
  return products;
}

/**
 * 从履约方式 + 上下文解析出「这次要用哪家店」。
 *
 * 抽出来是因为它有两个用处，必须共用同一份结果：
 *   1. 查这家的菜单（选品/加购都靠它）；
 *   2. **写回购物车**（外送算配送费必须知道 storeCode + beCode）。
 *
 * 早期这两步是分开的 —— 查菜单时内部算了一次门店，但没往外传，
 * 于是手动加购的商品进了车，车上的 storeCode 却是空的，
 * 算配送费时 `applyDeliveryFee` 直接 return，用户看到的合计少了运费。
 */
async function resolveStoreForFulfillment(
  userId: string,
  fulfillment: Fulfillment,
  ctx: { storeCode?: string; beCode?: string; addressId?: string },
): Promise<{ storeCode: string; beCode: string; name: string } | null> {
  const { delivery } = fulfillmentArgs(fulfillment);

  if (ctx.storeCode) {
    return { storeCode: ctx.storeCode, beCode: ctx.beCode ?? '', name: '' };
  }

  if (delivery) {
    if (!ctx.addressId) return null;
    const stores = await queryDeliveryStores(userId, ctx.addressId);
    const s = stores[0];
    if (!s) return null;
    return { storeCode: s.storeCode, beCode: s.beCode ?? '', name: s.name ?? '' };
  }

  const store = await resolveNearbyStoreAny(userId);
  if (!store) return null;
  return { storeCode: store.storeCode, beCode: store.beCode ?? '', name: store.name ?? '' };
}

/**
 * 按履约方式取一份商品池。
 *
 * ⚠️ 到店和外送是两套编码，这里必须严格照着履约方式查，
 * 否则搜出来的商品下单时 MCP 会说"商品不存在"。
 */
async function fetchProductsForFulfillment(
  userId: string,
  fulfillment: Fulfillment,
  ctx: { storeCode?: string; beCode?: string; addressId?: string },
): Promise<RawProductLite[]> {
  try {
    const { orderType, beType } = fulfillmentArgs(fulfillment);

    const store = await resolveStoreForFulfillment(userId, fulfillment, ctx);
    if (!store) return [];

    const raw = await callTool(userId, 'query-meals', {
      storeCode: String(store.storeCode),
      orderType,
      beType,
      ...(store.beCode ? { beCode: store.beCode } : {}),
    });
    return adaptProducts(raw);
  } catch (err) {
    log.warn(`购物车取商品池失败：${(err as Error).message}`);
    return [];
  }
}

/**
 * 到店场景取一家门店（手动加购时没有对话上下文，只能就近找）。
 *
 * 这里不走 orchestrator 的 resolveNearbyStore：那个依赖用户记忆里的
 * 常用城市/门店，而手动加购的场景通常发生在新用户身上（还没有记忆）。
 * 城市先用环境变量兜底，取不到再退回「厦门市」——和此前验证脚本一致。
 */
async function resolveNearbyStoreAny(
  userId: string,
): Promise<{ storeCode: string; beCode?: string; name?: string } | null> {
  const city = process.env.MCD_DEFAULT_CITY || '厦门市';
  try {
    const raw = await callTool(userId, 'query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city,
      keyword: '麦当劳',
    });
    const stores = adaptStores(raw).filter((s) => s.storeCode);
    const s = stores[0];
    if (!s) return null;
    return {
      storeCode: s.storeCode,
      ...(s.beCode ? { beCode: s.beCode } : {}),
      ...(s.name ? { name: s.name } : {}),
    };
  } catch (err) {
    log.warn(`购物车取门店失败：${(err as Error).message}`);
    return null;
  }
}

export interface ResolvedProduct {
  product: RawProductLite;
  storeCode?: string;
  beCode?: string;
  /** 门店名。下单时要落到订单上，否则用户不知道这单是哪家店 */
  storeName?: string;
}

/**
 * 按编码解析商品；找不到返回 null（路由层转成 404）。
 *
 * 会把**实际使用的门店**一起返回：调用方要把它写进购物车，
 * 否则外送车没有 storeCode/beCode，算配送费时会被直接跳过，
 * 用户看到的合计就少了运费。
 */
export async function resolveProduct(
  userId: string,
  productId: string,
  fulfillment: Fulfillment,
  ctx: { storeCode?: string; beCode?: string; addressId?: string } = {},
): Promise<ResolvedProduct | null> {
  const products = await loadProducts(userId, fulfillment, ctx);
  const p = products.find((x) => String(x.productId ?? x.code ?? '') === productId);
  if (!p) return null;

  // 复用同一条解析路径，保证「查菜单用的店」和「写进车的店」是同一家
  const store = await resolveStoreForFulfillment(userId, fulfillment, ctx);

  return {
    product: p,
    ...(store?.storeCode ? { storeCode: store.storeCode } : {}),
    ...(store?.beCode ? { beCode: store.beCode } : {}),
    ...(store?.name ? { storeName: store.name } : {}),
  };
}

/** 搜索商品（手动加购的搜索框用） */
export async function searchProducts(
  userId: string,
  keyword: string,
  fulfillment: Fulfillment,
  ctx: { storeCode?: string; beCode?: string; addressId?: string } = {},
): Promise<RawProductLite[]> {
  const products = await loadProducts(userId, fulfillment, ctx);
  const k = keyword.trim().toLowerCase();
  if (!k) return products.slice(0, 30);
  return products
    .filter((p) => String(p.name ?? '').toLowerCase().includes(k))
    .slice(0, 30);
}

/* ------------------------------------------------------------------ */
/* 给下单用：购物车 → 菜单快照                                        */
/* ------------------------------------------------------------------ */

/**
 * 把购物车转成下单要的 MenuItem[]。
 *
 * 这里必须**反过来**把小计算回去（单价 × 数量），
 * 因为 confirmOrder 是按 MenuItem.price 当小计累加的。
 */
export function cartToMenu(cart: Cart): MenuItem[] {
  return cart.items.map((it) => ({
    name: it.name,
    spec: [`×${it.qty}`, it.spec].filter(Boolean).join(' · '),
    why: it.why ?? '',
    price: Math.round(it.price * it.qty * 100) / 100,
    productId: it.productId,
    ...(it.originalPrice !== undefined
      ? { originalPrice: Math.round(it.originalPrice * it.qty * 100) / 100 }
      : {}),
    ...(it.modifications?.length ? { modifications: it.modifications } : {}),
  }));
}
