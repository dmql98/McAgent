/**
 * 订单服务（M6 直下单）
 *
 * 安全边界（PRD §7 / 架构 §10）：
 * - 归属校验：chatId / orderId 必须属于当前用户
 * - 快照校验：菜单 hash 与确认时一致
 * - 价格复核：服务端用 calculate-price 重算，**永不信前端金额**
 * - 幂等：同 chatId 重复 confirm 返回同一订单
 * - 支付边界：只透传 payUrl，**无任何代付/自动支付代码路径**
 */
import { createLogger } from '../lib/logger.js';
import {
  AuthError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  OrderConflictError,
  OrderRejectedError,
} from '../lib/errors.js';
import { getDb } from '../db/index.js';
import { callTool } from '../mcp/gateway.js';
import { adaptOrder, adaptPrice, adaptStores, type PriceInfo } from './mcp-adapter.js';
import { stableHash } from '../lib/crypto.js';
import { randomUUID } from 'node:crypto';
import { getMemoryService } from './memory.service.js';
import { pickAddress, resolveDeliveryStore, calcDeliveryPrice, isDelivery } from './delivery.service.js';
import { getCart, cartToMenu } from './cart.service.js';
import type {
  ChatReply,
  DeliveryFeeInfo,
  Fulfillment,
  OrderStatus,
  OrderStatusResponse,
  OrderConfirmResponse,
} from '../types/contract.js';

const log = createLogger('order');

interface ChatRow {
  id: string;
  user_id: string | null;
  messages: string;
  reply_json: string | null;
  menu_hash: string | null;
  created_at: number;
  fulfillment: string | null;
  address_id: string | null;
  address_text: string | null;
  store_code: string | null;
  be_code: string | null;
}

interface OrderRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  menu_json: string;
  menu_hash: string | null;
  total: number;
  status: string;
  pay_url: string | null;
  store: string | null;
  created_at: number;
  updated_at: number;
  fulfillment: string | null;
  address_id: string | null;
  address_text: string | null;
}

/* ------------------------------------------------------------------ */
/* 状态映射                                                          */
/* ------------------------------------------------------------------ */

const STATUS_MAP: Record<string, { status: OrderStatus; text: string }> = {
  created: { status: 'created', text: '订单已创建，等你付款' },
  pending: { status: 'created', text: '订单已创建，等你付款' },
  unpaid: { status: 'created', text: '订单已创建，等你付款' },
  waitpay: { status: 'created', text: '订单已创建，等你付款' },
  paid: { status: 'paid', text: '收到钱了，正在准备' },
  payed: { status: 'paid', text: '收到钱了，正在准备' },
  making: { status: 'progress', text: '正在为你出餐…' },
  processing: { status: 'progress', text: '正在为你出餐…' },
  progress: { status: 'progress', text: '正在为你出餐…' },
  preparing: { status: 'progress', text: '正在为你出餐…' },
  completed: { status: 'done', text: '可以取餐了' },
  done: { status: 'done', text: '可以取餐了' },
  finished: { status: 'done', text: '可以取餐了' },
  canceled: { status: 'canceled', text: '订单已取消' },
  cancelled: { status: 'canceled', text: '订单已取消' },
  closed: { status: 'canceled', text: '订单已取消' },
};

export function mapOrderStatus(raw: string): { status: OrderStatus; text: string } {
  const key = (raw ?? '').toLowerCase().trim();
  return STATUS_MAP[key] ?? { status: 'created', text: `订单状态：${raw || '未知'}` };
}

/* ------------------------------------------------------------------ */
/* 确认下单                                                          */
/* ------------------------------------------------------------------ */

export async function confirmOrder(
  userId: string,
  chatId: string,
  opts: { fulfillment?: Fulfillment; addressId?: string } = {},
): Promise<OrderConfirmResponse> {
  if (!chatId) throw new BadRequestError('缺少 chatId');

  const db = getDb();

  /* --- 1. 归属校验 --- */
  const chat = db
    .prepare('SELECT * FROM chats WHERE id = ?')
    .get<ChatRow>(chatId);
  if (!chat) throw new NotFoundError('这个对话找不到了，重新问一次吧');
  if (chat.user_id !== userId) {
    log.warn(`越权尝试：user=${userId} 访问 chat=${chatId}`);
    throw new ForbiddenError('这个对话不是你的');
  }

  /* --- 2. 幂等：已有未取消订单直接返回 --- */
  const existing = db
    .prepare('SELECT * FROM orders WHERE chat_id = ? AND status != ? ORDER BY created_at DESC LIMIT 1')
    .get<OrderRow>(chatId, 'canceled');
  if (existing) {
    log.info(`幂等命中 chat=${chatId} order=${existing.id}`);
    const resp: OrderConfirmResponse = {
      orderId: existing.id,
      payUrl: existing.pay_url ?? '',
      total: existing.total,
      store: existing.store ?? '',
      reused: true,
      ...(existing.fulfillment ? { fulfillment: existing.fulfillment as Fulfillment } : {}),
      ...(existing.address_text ? { address: existing.address_text } : {}),
    };
    return resp;
  }

  /* --- 3. 快照校验 --- */
  if (!chat.reply_json) throw new OrderConflictError('这个对话没有可下单的菜单');
  const reply = JSON.parse(chat.reply_json) as ChatReply;
  if (!reply.menu || reply.menu.length === 0) {
    throw new BadRequestError('这单里没有菜单，先说想吃什么');
  }

  const currentHash = stableHash(reply.menu);
  if (chat.menu_hash && chat.menu_hash !== currentHash) {
    throw new OrderConflictError('菜单在你确认期间变了，请重新确认');
  }

  /**
   * 商品必须有 productCode 才能下单。
   * 真实菜单的 code 一定存在；如果这里为空，说明是历史脏数据，
   * 与其让 MCP 报一句看不懂的错，不如直接告诉用户重新点一次。
   */
  const missingCode = reply.menu.filter((m) => !m.productId);
  if (missingCode.length > 0) {
    log.warn(`菜单含无 productCode 的商品：${missingCode.map((m) => m.name).join('/')}`);
    throw new OrderConflictError('这单里有商品查不到编码，重新问我一次吧');
  }

  /* --- 4. 确定履约方式（以对话时选的为准） --- */
  /**
   * 优先级：请求显式传入 > chat 落库的 > 菜单 meta 里的 > 默认自取。
   *
   * 正常情况下前端不该传，直接沿用对话时选的那个 ——
   * 因为菜单里的商品编码是按当时那套场景查的，换场景必然对不上。
   */
  const fulfillment: Fulfillment =
    opts.fulfillment ??
    (chat.fulfillment as Fulfillment | null) ??
    reply.meta.fulfillment ??
    '自取';
  const delivery = isDelivery(fulfillment);

  if (opts.fulfillment && chat.fulfillment && opts.fulfillment !== chat.fulfillment) {
    throw new OrderConflictError(
      '这单是按下单方式（' + chat.fulfillment + '）挑的，换方式要重新问一次',
    );
  }

  let addressId = opts.addressId ?? chat.address_id ?? undefined;
  let deliveryAddressText = chat.address_text ?? undefined;
  let beCode = chat.be_code ?? undefined;
  let deliveryFee: DeliveryFeeInfo | undefined;

  if (delivery) {
    const addr = await pickAddress(userId, addressId);
    if (!addr) {
      throw new BadRequestError('麦乐送要先选一个配送地址');
    }
    addressId = addr.addressId;
    deliveryAddressText =
      deliveryAddressText ?? [addr.contactName, addr.phone, addr.fullAddress].filter(Boolean).join(' · ');
  }

  /* --- 5. 取门店 + 价格复核（服务端重算，不信前端） --- */
  let storeCode: string;
  /** 查门店时拿到的名字，后面给订单兜底用 */
  let resolvedStoreName = '';
  if (delivery) {
    // 外送门店必须按地址重查，且 beCode 是算价/建单的必需品
    if (chat.store_code && beCode) {
      storeCode = chat.store_code;
    } else {
      const s = await resolveDeliveryStore(userId, addressId!, reply.meta.store || undefined);
      storeCode = s.storeCode;
      beCode = s.beCode;
      resolvedStoreName = s.name;
    }
    if (!beCode) throw new OrderConflictError('这家外送门店没给业务编码，换个地址试试');
  } else {
    const shop = await resolveStoreCode(userId, reply.meta.store, chat.store_code ?? undefined);
    storeCode = shop.storeCode;
    resolvedStoreName = shop.name;
    if (shop.beCode) beCode = shop.beCode;
  }

  const items = reply.menu.map((m) => ({
    productCode: m.productId!,
    quantity: parseQty(m.spec),
  }));

  const priceInfo = delivery
    ? await calcDeliveryPrice(userId, {
        storeCode,
        beCode: beCode!,
        addressId: addressId!,
        items,
      })
    : await recheckPrice(userId, storeCode, items);

  if (priceInfo) {
    if (delivery) {
      deliveryFee = {
        delivery: priceInfo.deliveryFee ?? 0,
        packing: priceInfo.packingFee ?? 0,
        ...(priceInfo.minOrder !== undefined ? { minOrder: priceInfo.minOrder } : {}),
      };
    }
    /**
     * 外送的 total 含配送费与打包费，不能拿它跟菜单商品合计直接比 ——
     * 菜单里 total 也是算价出来的（同样含费用），所以可以直接比。
     * 差异超过 1 元就认为价格变了，让用户重看。
     */
    if (Math.abs(priceInfo.total - reply.total) > 1) {
      throw new OrderConflictError(
        `菜单价格刚刚变了（现在 ¥${priceInfo.total.toFixed(1)}），要按新价格下单吗？`,
      );
    }
  }

  /**
   * takeWayCode 是**到店** create-order 的必填项，取值只能来自
   * calculate-price 返回的 takeWayList[].code。
   * 外送没有 takeWayList，用不上也不该传（传了会报错）。
   */
  let takeWayCode: string | undefined;
  if (!delivery) {
    takeWayCode = priceInfo?.takeWay?.code;
    if (!takeWayCode) {
      throw new OrderConflictError('没拿到取餐方式，稍后再试一次');
    }
  }

  /* --- 6. 建单 --- */
  const orderPayload: Record<string, unknown> = {
    storeCode,
    orderType: delivery ? 2 : 1,
    beType: delivery ? 2 : 1,
    items,
  };
  if (delivery) {
    orderPayload.beCode = beCode;
    orderPayload.addressId = addressId;
  } else {
    orderPayload.takeWayCode = takeWayCode;
    if (beCode) orderPayload.beCode = beCode;
  }

  const raw = await callTool(userId, 'create-order', orderPayload, { cacheTtl: null, timeoutMs: 30_000 });
  const order = adaptOrder(raw);

  /**
   * 建单失败要分清两种情况，不能都回「看不懂」：
   *
   *   A. MCP **明确说了原因**（`success:false` + message）——比如
   *      「今日下单数已经上限」「商品已售罄」「门店休息中」。
   *      这种必须把原话透给用户，否则他只会反复重试，永远不知道要等明天。
   *
   *   B. 响应结构真的认不出（既没 orderId，也没有可读的 message）——
   *      这才是「看不懂」，让用户去 App 里核对有没有下单成功。
   *
   * 两种情况都**不能**落库成订单，但话术必须不同。
   */
  if (!order) {
    const reason = mcpFailureReason(raw);
    if (reason) {
      log.warn(`create-order 被拒绝：${reason}`);
      throw new OrderRejectedError(`下单没成功：${reason}`);
    }
    log.error(`create-order 返回无法解析：${JSON.stringify(raw).slice(0, 400)}`);
    throw new OrderConflictError('建单返回看不懂，先在麦当劳 App 里看看有没有');
  }

  /* --- 7. 落库 --- */
  const now = Date.now();

  /**
   * 门店名三级兜底，优先级从高到低：
   *   1. 建单响应里的 `orderDetail.storeName` —— 麦当劳自己写的，绝对准；
   *   2. 前面查门店时得到的名字；
   *   3. 菜单里的 meta.store。
   * 早期只看第 3 项，而购物车下单时 meta.store 常常是空的，
   * 于是订单落库的门店是空串、接口返回的 store 也是空串。
   */
  const storeName = order.storeName || resolvedStoreName || reply.meta.store || '';
  if (!storeName) log.warn(`订单 ${order.orderId} 没拿到门店名（storeCode=${storeCode}）`);

  db.prepare(
    `INSERT INTO orders (id, user_id, chat_id, menu_json, menu_hash, total, status, pay_url, store, created_at, updated_at,
                         fulfillment, address_id, address_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.orderId,
    userId,
    chatId,
    JSON.stringify(reply.menu),
    currentHash,
    order.total ?? reply.total,
    'created',
    order.payUrl,
    storeName,
    now,
    now,
    fulfillment,
    addressId ?? null,
    deliveryAddressText ?? null,
  );

  /* --- 7. 更新习惯（下单即记，不代表已付款） --- */
  try {
    await getMemoryService().recordOrder(userId, {
      date: isoDate(new Date()),
      items: reply.menu.map((m) => m.name),
      total: order.total ?? reply.total,
      store: storeName,
    });
  } catch (err) {
    log.warn(`记忆更新失败（已忽略）：${(err as Error).message}`);
  }

  log.info(
    `建单成功 user=${userId} order=${order.orderId} total=${order.total ?? reply.total} ` +
      `fulfillment=${fulfillment} store=${storeName || '-'}`,
  );

  const resp: OrderConfirmResponse = {
    orderId: order.orderId,
    payUrl: order.payUrl,
    total: order.total ?? reply.total,
    store: storeName,
    reused: false,
    fulfillment,
    ...(deliveryAddressText ? { address: deliveryAddressText } : {}),
    ...(deliveryFee ? { deliveryFee } : {}),
  };
  return resp;
}

/* ------------------------------------------------------------------ */
/* 门店与价格复核                                                     */
/* ------------------------------------------------------------------ */

interface ResolvedStore {
  storeCode: string;
  name: string;
  beCode?: string;
}

/**
 * 把 reply 里的门店名换回 storeCode。
 *
 * 优先用 chat 里已经落库的 storeCode —— 那是查菜单时**真实用过**的门店，
 * 比按名字重搜可靠得多（重搜可能匹配到同城另一家同名店）。
 * 只有历史数据没有 storeCode 时才退回按名字搜。
 */
async function resolveStoreCode(
  userId: string,
  storeName: string,
  knownStoreCode?: string,
): Promise<ResolvedStore> {
  if (knownStoreCode) {
    /**
     * 有编码就直接用，但名字可能没有 —— 购物车/历史快照里只存了 storeCode 的情况很常见。
     * 这时仍要试一次按名字反查，否则订单上的「门店」会是空字符串，
     * 用户拿到支付链接都不知道这单是送到哪家店。
     */
    return { storeCode: knownStoreCode, name: storeName || (await lookupStoreName(userId, knownStoreCode)) };
  }

  const snapshot = getMemoryService().snapshot(userId, new Date());
  const city = snapshot?.usualCity ?? '';
  const keyword = storeName || snapshot?.usualStore || '';

  const attempts: Array<Record<string, unknown>> = [];
  if (city) attempts.push({ beType: 1, searchType: 2, city, keyword });
  if (city && keyword !== '麦当劳') attempts.push({ beType: 1, searchType: 2, city, keyword: '麦当劳' });

  for (const args of attempts) {
    try {
      const raw = await callTool(userId, 'query-nearby-stores', args);
      const stores = adaptStores(raw);
      if (stores.length === 0) continue;

      // 名字完全匹配 → 包含匹配 → 第一个
      const exact = stores.find((s) => s.name === storeName);
      const loose = stores.find((s) => s.name.includes(storeName) || storeName.includes(s.name));
      const hit = exact ?? loose ?? stores[0]!;
      return {
        storeCode: hit.storeCode,
        name: hit.name,
        ...(hit.beCode ? { beCode: hit.beCode } : {}),
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      log.warn(`下单前查门店失败：${(err as Error).message}`);
    }
  }

  throw new OrderConflictError('找不到这单对应的门店，重新问我一次吧');
}

/**
 * 按 storeCode 反查门店名。
 *
 * 查不到就返回空串，**绝不编一个名字** —— 订单上的门店写错，
 * 比空着更糟（用户会跑去错的店取餐）。
 */
async function lookupStoreName(userId: string, storeCode: string): Promise<string> {
  const snapshot = getMemoryService().snapshot(userId, new Date());
  const city = snapshot?.usualCity || process.env.MCD_DEFAULT_CITY || '厦门市';
  try {
    const raw = await callTool(userId, 'query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city,
      keyword: '麦当劳',
    });
    const hit = adaptStores(raw).find((s) => s.storeCode === storeCode);
    return hit?.name ?? '';
  } catch (err) {
    if (err instanceof AuthError) throw err;
    log.warn(`按编码反查门店名失败（${storeCode}）：${(err as Error).message}`);
    return '';
  }
}

/**
 * 价格复核。
 *
 * 除了校验金额，还要顺手取出 takeWayCode —— 那是 create-order 的必填项，
 * 且只能从 calculate-price 的 takeWayList 里拿。
 */
async function recheckPrice(
  userId: string,
  storeCode: string,
  items: Array<{ productCode: string; quantity: number }>,
): Promise<PriceInfo | null> {
  try {
    const raw = await callTool(
      userId,
      'calculate-price',
      { storeCode, orderType: 1, beType: 1, items },
      { cacheTtl: null, timeoutMs: 20_000 },
    );
    const info = adaptPrice(raw);
    if (!info) {
      log.warn('calculate-price 返回无法解析');
      return null;
    }
    return info;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // 复核失败不应阻塞下单（价格由 create-order 最终决定），但要记录
    log.warn(`价格复核失败（不阻塞）：${(err as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 从购物车下单                                                       */
/* ------------------------------------------------------------------ */

/**
 * 按**当前购物车**下单。
 *
 * 为什么需要这条：菜单现在放在购物车里，用户随时可以删一份薯条、
 * 加一杯可乐。如果下单还走"对话时那份菜单快照"，就会
 * 「明明删了薯条，付款还是按原菜单算钱」—— 这是最不能接受的错。
 *
 * 实现上不复制 confirmOrder 的流程（那段有门店解析、价格复核、
 * takeWayCode、幂等、落库，抄一遍必然漂移），而是：
 *   1. 把购物车快照成一条 chats 记录（menu_hash 一起算好）；
 *   2. 直接调 confirmOrder 走原路径。
 * 这样两条下单路径永远一致，任何一边的修复都会同时生效。
 */
export async function confirmFromCart(
  userId: string,
  opts: { fulfillment: Fulfillment; addressId?: string; chatId?: string } = { fulfillment: '自取' },
): Promise<OrderConfirmResponse> {
  const cart = await getCart(userId, opts.fulfillment);
  if (cart.items.length === 0) {
    throw new BadRequestError('购物车是空的，先加点东西');
  }

  const menu = cartToMenu(cart);
  const missing = menu.filter((m) => !m.productId);
  if (missing.length > 0) {
    log.warn(`购物车含无编码商品：${missing.map((m) => m.name).join('/')}`);
    throw new OrderConflictError('购物车里有商品查不到编码，删掉重加一次');
  }

  const reply: ChatReply = {
    hook: '按购物车下单',
    meta: {
      store: cart.store ?? '',
      slot: '',
      title: '购物车',
      fulfillment: opts.fulfillment,
    },
    menu,
    total: cart.total,
    quote: '',
    actions: [],
    dataSource: 'mcp',
  };

  const db = getDb();
  const chatId = opts.chatId ?? `cart-${randomUUID()}`;
  const now = Date.now();

  /**
   * 业务编码必须落进 chats：外送没有 beCode 算不了价、建不了单。
   * 这里把购物车记下的门店信息整份带过去。
   */
  db.prepare(
    `INSERT INTO chats (id, user_id, messages, reply_json, menu_hash, created_at,
                        fulfillment, address_id, address_text, store_code, be_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       reply_json = excluded.reply_json,
       menu_hash = excluded.menu_hash,
       fulfillment = excluded.fulfillment,
       address_id = COALESCE(excluded.address_id, chats.address_id),
       address_text = COALESCE(excluded.address_text, chats.address_text),
       store_code = COALESCE(excluded.store_code, chats.store_code),
       be_code = COALESCE(excluded.be_code, chats.be_code)`,
  ).run(
    chatId,
    userId,
    JSON.stringify([{ role: 'system', text: '按购物车下单' }]),
    JSON.stringify(reply),
    stableHash(menu),
    now,
    opts.fulfillment,
    opts.addressId ?? cart.addressId ?? null,
    cart.address ?? null,
    cart.storeCode ?? null,
    cart.beCode ?? null,
  );

  return confirmOrder(userId, chatId, {
    fulfillment: opts.fulfillment,
    ...(opts.addressId ?? cart.addressId ? { addressId: opts.addressId ?? cart.addressId } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* 建单失败原因                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从 MCP 的失败响应里读出「人话」。
 *
 * 真实返回长这样：
 *   {"success":false,"code":600039,"message":"今日下单数已经上限", ...}
 *
 * 这类响应本身是**完全可读**的，只是没有 orderId 而已。
 * 早期一律回「建单返回看不懂，先去 App 里看看」——
 * 用户根本不知道是被限购了，只会一直重试，重试到明天也一样失败。
 *
 * 只有既没有 orderId、也没有可读 message 时才算真的「看不懂」。
 */
export function mcpFailureReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  // success/module 显式为 false 才算失败声明，避免把正常响应误判
  const ok = o.success ?? o['ok'];
  if (ok === undefined || ok === true) return null;

  const msg = typeof o.message === 'string' ? o.message.trim() : '';
  if (!msg) return null;

  /**
   * 少数 message 是「请求成功」这类无意义文案（配合 success:false 出现），
   * 那种情况宁可回「看不懂」，也别给用户一句废话。
   */
  if (/^(请求成功|成功|success|ok)$/i.test(msg)) return null;

  return msg;
}

/* ------------------------------------------------------------------ */
/* 订单状态                                                          */
/* ------------------------------------------------------------------ */

export async function getOrderStatus(userId: string, orderId: string): Promise<OrderStatusResponse> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get<OrderRow>(orderId);
  if (!row) throw new NotFoundError('没找到这个订单');
  if (row.user_id !== userId) throw new ForbiddenError('这个订单不是你的');

  // 终态不再查 MCP，省额度
  const cached = mapOrderStatus(row.status);
  if (cached.status === 'done' || cached.status === 'canceled') {
    return {
      orderId,
      status: cached.status,
      progressText: cached.text,
      ...(row.pay_url ? { payUrl: row.pay_url } : {}),
      updatedAt: row.updated_at,
      total: row.total,
    };
  }

  let rawStatus = row.status;
  try {
    const raw = await callTool(userId, 'query-order', { orderId }, { cacheTtl: null, timeoutMs: 15_000 });
    const order = adaptOrder(raw);
    if (order) rawStatus = order.status;
  } catch (err) {
    // 查不到就用库里的状态，别让前端卡住
    log.warn(`query-order 失败，用本地状态：${(err as Error).message}`);
  }

  const mapped = mapOrderStatus(rawStatus);

  if (mapped.status !== row.status) {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(
      mapped.status,
      Date.now(),
      orderId,
    );

    // 完成时补一次记忆（真实完成，不是下单）
    if (mapped.status === 'done') {
      log.info(`订单完成 order=${orderId}`);
    }
  }

  return {
    orderId,
    status: mapped.status,
    progressText: mapped.text,
    ...(row.pay_url ? { payUrl: row.pay_url } : {}),
    updatedAt: Date.now(),
    total: row.total,
  };
}

/* ------------------------------------------------------------------ */
/* 取消订单                                                          */
/* ------------------------------------------------------------------ */

export async function cancelOrder(userId: string, orderId: string): Promise<{ ok: true }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get<OrderRow>(orderId);
  if (!row) throw new NotFoundError('没找到这个订单');
  if (row.user_id !== userId) throw new ForbiddenError('这个订单不是你的');

  const cur = mapOrderStatus(row.status);
  if (cur.status === 'canceled') return { ok: true };
  if (cur.status === 'done') throw new OrderConflictError('这单已经完成了，取消不了');
  if (cur.status === 'progress') {
    throw new OrderConflictError('已经在做了，取消不了。要是做错了可以联系门店');
  }

  await callTool(userId, 'cancel-order', { orderId }, { cacheTtl: null, timeoutMs: 20_000 });

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(
    'canceled',
    Date.now(),
    orderId,
  );
  log.info(`订单取消 order=${orderId}`);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                              */
/* ------------------------------------------------------------------ */

/** 从 "×2 · 去冰" 里取数量 */
export function parseQty(spec: string): number {
  const m = (spec ?? '').match(/×\s*(\d+)/);
  if (m?.[1]) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 50) return n;
  }
  return 1;
}

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
