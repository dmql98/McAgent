/**
 * 「MCP 数据面」路由
 *
 * 设计原则：一个面板一个接口，接口内部并行调多个工具，一次往返给齐前端要的全部内容。
 * 每个区块都带 meta（用的哪个工具 / 耗时 / 是否缓存 / 原始文本片段），
 * 前端据此把「这条数据是刚查的还是缓存」直接画出来 —— 这就是"把 MCP 展现出来"。
 *
 *   GET  /api/explorer/overview        总览（账户+时间+门店+券数+在售餐品数+工具统计）
 *   GET  /api/explorer/stores          门店搜索（city/keyword/beType）
 *   GET  /api/explorer/menu            菜单全量（分类 + 常点）
 *   GET  /api/explorer/meal/:code      餐品详情（特制项 / 套餐组成）
 *   GET  /api/explorer/nutrition       营养表（160 条，支持 q 过滤）
 *   GET  /api/explorer/coupons         三类券（卡包/可领/门店）
 *   GET  /api/explorer/points          积分账户 + 抽奖活动 + 我的奖品
 *   GET  /api/explorer/mall            积分商城商品
 *   GET  /api/explorer/mall/:spuId     商城商品详情（SKU）
 *   GET  /api/explorer/orders          历史订单（餐品）+ 商城订单
 *   GET  /api/explorer/order/:orderId  单笔订单详情
 *   GET  /api/explorer/campaigns       活动日历
 *   GET  /api/explorer/parties         派对城市（派对链路第一步）
 *   GET  /api/explorer/parties/stores  城市下的派对门店
 *   GET  /api/explorer/parties/dates   门店可约日期
 *   GET  /api/explorer/parties/sessions 某天的场次
 *   GET  /api/explorer/addresses       外送地址
 *   GET  /api/explorer/tools           35 个工具的目录（能力清单）
 *   POST /api/explorer/tools/:name     工具台直调（写操作需 confirm:true）
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUserId, requireAuth } from '../middleware/jwt.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { BadRequestError } from '../lib/errors.js';
import { TOOL_CATALOG, catalogStats, TOOL_GROUPS } from '../mcp/catalog.js';
import { READONLY_CACHE_TTL, WRITE_TOOLS, rateLimitStats, gatewayStats } from '../mcp/gateway.js';
import { getMemoryService } from '../services/memory.service.js';
import {
  exploreStores,
  parseAccount,
  parseAddresses,
  parseAvailableCouponsMd,
  parseCampaignMd,
  parseLottery,
  parseMallDetail,
  parseMallProducts,
  parseMealDetail,
  parseMenu,
  parseMyCouponsMd,
  parseNutrition,
  parseOrder,
  parseOrderList,
  parsePartyCities,
  parsePartyDates,
  parsePartySessions,
  parsePartyStores,
  parsePrizes,
  parsePrice,
  parseStoreCoupons,
  parseStoreCards,
  runTool,
  humanTtl,
  type Block,
  type BlockMeta,
} from '../services/explorer.service.js';
import { callToolEnvelope } from '../mcp/gateway.js';
import { resolveStore } from '../services/store.service.js';

export const explorerRouter = Router();

/* ------------------------------------------------------------------ */
/* 小工具                                                            */
/* ------------------------------------------------------------------ */

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
};

/**
 * 解释「为什么这一块是空的」。
 * 麦当劳的业务失败长这样：{success:false, code:400, message:"缺少参数"}，
 * HTTP 200、isError 也不为真，只是数据不在。这种情况下说"解析失败"会误导人
 * 去怀疑解析器，实际上是要补参数。所以这里优先返回服务端自己的说法。
 */
function explainEmpty(decoded: unknown, tool: string): string | undefined {
  if (!decoded || typeof decoded !== 'object') return undefined;
  const o = decoded as Record<string, unknown>;
  if (o.success === false || (typeof o.code === 'number' && o.code !== 0 && o.code !== 200)) {
    const msg = typeof o.message === 'string' ? o.message : '';
    const cat = TOOL_CATALOG.find((t) => t.name === tool);
    const needNames = (cat?.args ?? []).filter((a) => a.required).map((a) => a.name);
    const need = needNames.length ? `（该工具必填：${needNames.join('、')}）` : '';
    return `麦当劳返回业务错误：${msg || `code=${String(o.code)}`}${need}`;
  }
  return undefined;
}

/** 统一区块构造：把工具调用的信封转成前端要的 meta */
async function block<T>(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  parse: (data: unknown, text?: string) => T,
  empty: T,
  opts: { cacheTtl?: number | null; timeoutMs?: number } = {},
): Promise<Block<T>> {
  const cat = TOOL_CATALOG.find((t) => t.name === tool);
  try {
    const env = await callToolEnvelope(userId, tool, args, opts);
    const data = parse(env.data, env.rawText);
    const meta: BlockMeta = {
      tool,
      title: cat?.title ?? tool,
      cached: env.cached,
      costMs: env.costMs,
      source: env.cached ? 'cache' : 'mcp',
      ...(env.rawText ? { rawPreview: env.rawText.slice(0, 800) } : {}),
    };
    const emptyResult =
      data === undefined ||
      data === null ||
      (Array.isArray(data) && data.length === 0) ||
      (typeof data === 'object' && !Array.isArray(data) && Object.keys(data as object).length === 0);
    if (emptyResult) {
      meta.source = 'empty';
      // 分清两种空：服务端说失败了（参数没给对），还是解析器认不出这个结构。
      // 前者要让人去改参数，后者才是解析器的锅，界面上必须说清楚。
      meta.reason = explainEmpty(env.data, tool) ?? '服务端返回了内容，但没能解析出条目';
    }
    return { meta, data: emptyResult ? empty : data };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED') throw err;
    return {
      meta: {
        tool,
        title: cat?.title ?? tool,
        cached: false,
        costMs: 0,
        source: 'empty',
        reason: (err as Error).message || '调用失败',
      },
      data: empty,
    };
  }
}

/** 并发拉多个区块时，单个失败不影响其它（已在 block 内降级） */

/* ------------------------------------------------------------------ */
/* 1. 总览                                                            */
/* ------------------------------------------------------------------ */

explorerRouter.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const snap = getMemoryService().snapshot(userId);

    // 门店先解析（后面菜单要用），失败不阻塞总览
    let store: { storeCode: string; name: string; city?: string } | null = null;
    let storeBlock: Block<unknown> | null = null;
    try {
      const r = await resolveStore(userId);
      store = { storeCode: r.store.storeCode, name: r.store.name };
      if (r.city) store.city = r.city;
      storeBlock = {
        meta: { tool: 'query-nearby-stores', title: '附近门店', cached: false, costMs: 0, source: 'mcp' },
        data: r.store,
      };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED') throw err;
      storeBlock = {
        meta: {
          tool: 'query-nearby-stores',
          title: '附近门店',
          cached: false,
          costMs: 0,
          source: 'empty',
          reason: (err as Error).message,
        },
        data: null,
      };
    }

    const [timeBlock, accountBlock, cardBlock, claimBlock, menuBlock] = await Promise.all([
      block(userId, 'now-time-info', {}, (d) => {
        const o = (d && typeof d === 'object' ? ((d as Record<string, unknown>).data ?? d) : d) as
          | Record<string, unknown>
          | undefined;
        if (!o || typeof o !== 'object') return undefined;
        return {
          datetime: typeof o.datetime === 'string' ? o.datetime : undefined,
          formatted: typeof o.formatted === 'string' ? o.formatted : undefined,
          dayOfWeek: typeof o.dayOfWeek === 'string' ? o.dayOfWeek : undefined,
          timezone: typeof o.timezone === 'string' ? o.timezone : undefined,
          timestamp: num(o.timestamp),
        };
      }, undefined),

      block(userId, 'query-my-account', {}, parseAccount, undefined),

      block(userId, 'query-my-coupons', { page: '1', pageSize: '200' }, (d, t) =>
        parseMyCouponsMd(typeof d === 'string' ? d : (t ?? '')), []),

      block(userId, 'available-coupons', {}, (d, t) =>
        parseAvailableCouponsMd(typeof d === 'string' ? d : (t ?? '')), []),

      store
        ? block(userId, 'query-meals', {
            storeCode: store.storeCode,
            orderType: 1,
            beType: 1,
          }, parseMenu, { categories: [], frequent: [], total: 0 })
        : Promise.resolve(null),
    ]);

    const menuTotal = menuBlock ? menuBlock.data.total : 0;
    const categories = menuBlock ? menuBlock.data.categories.length : 0;

    res.json({
      store,
      storeBlock,
      time: timeBlock,
      account: accountBlock,
      coupons: {
        card: cardBlock.data.length,
        claimable: claimBlock.data.length,
        cardBlock: cardBlock.meta,
        claimableBlock: claimBlock.meta,
      },
      menu: {
        total: menuTotal,
        categories,
        meta: menuBlock ? menuBlock.meta : null,
      },
      memory: {
        nickname: snap?.nickname ?? null,
        taboo: snap?.taboo ?? [],
        topItems: snap?.topItems ?? [],
        usualStore: snap?.usualStore ?? null,
        usualCity: snap?.usualCity ?? null,
        moods: snap?.recentMoods ?? [],
      },
      tools: {
        ...catalogStats(),
        rate: rateLimitStats(),
        gateway: gatewayStats(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 2. 门店 / 菜单 / 详情 / 营养                                        */
/* ------------------------------------------------------------------ */

explorerRouter.get('/stores', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const city = typeof req.query.city === 'string' ? req.query.city : undefined;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const beType = req.query.beType === '5' ? 5 : 1;
    const r = await exploreStores(userId, { ...(city ? { city } : {}), ...(keyword ? { keyword } : {}), beType });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/menu', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const storeCode = typeof req.query.storeCode === 'string' ? req.query.storeCode : undefined;
    const beType = req.query.beType === '5' ? 5 : 1;

    let useStore = storeCode;
    let storeName = '';
    let beCode: string | undefined;
    if (!useStore) {
      const r = await resolveStore(userId);
      useStore = r.store.storeCode;
      storeName = r.store.name;
      beCode = r.store.beCode;
    }

    const args: Record<string, unknown> = { storeCode: useStore, orderType: 1, beType };
    if (beCode && beType === 5) args.beCode = beCode;

    const r = await block(userId, 'query-meals', args, parseMenu, {
      categories: [],
      frequent: [],
      total: 0,
    });
    res.json({ ...r, storeCode: useStore, storeName });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/meal/:code', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const code = req.params.code;
    if (!code) throw new BadRequestError('缺少餐品编码');

    const storeCode = typeof req.query.storeCode === 'string' ? req.query.storeCode : '';
    let useStore = storeCode;
    if (!useStore) {
      const r = await resolveStore(userId);
      useStore = r.store.storeCode;
    }

    const r = await block(
      userId,
      'query-meal-detail',
      { storeCode: useStore, orderType: 1, beType: 1, code },
      parseMealDetail,
      undefined,
    );
    res.json({ ...r, storeCode: useStore });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/nutrition', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const r = await block(userId, 'list-nutrition-foods', {}, parseNutrition, []);
    let rows = r.data;
    if (q) rows = rows.filter((x) => x.productName.includes(q));

    // 排序：按热量降序，方便前端画"最顶的几个"
    const sorted = [...rows].sort((a, b) => (b.energyKcal ?? 0) - (a.energyKcal ?? 0));
    res.json({
      meta: r.meta,
      total: r.data.length,
      filtered: rows.length,
      q,
      rows,
      heaviest: sorted.slice(0, 8),
      lightest: [...rows].filter((x) => x.energyKcal !== undefined).sort((a, b) => (a.energyKcal ?? 0) - (b.energyKcal ?? 0)).slice(0, 8),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 3. 优惠券                                                          */
/* ------------------------------------------------------------------ */

explorerRouter.get('/coupons', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);

    // 门店券需要门店，没有就跳过（不阻塞另外两类）
    let storeRef: { storeCode: string; name: string } | null = null;
    let storeBlock: Block<unknown[]> | null = null;
    try {
      const r = await resolveStore(userId);
      storeRef = { storeCode: r.store.storeCode, name: r.store.name };
      storeBlock = await block(
        userId,
        'query-store-coupons',
        { storeCode: r.store.storeCode, orderType: 1, beType: 1 },
        parseStoreCoupons,
        [],
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED') throw err;
      storeBlock = {
        meta: {
          tool: 'query-store-coupons',
          title: '门店券',
          cached: false,
          costMs: 0,
          source: 'empty',
          reason: (err as Error).message,
        },
        data: [],
      };
    }

    const [card, claimable] = await Promise.all([
      block(userId, 'query-my-coupons', { page: '1', pageSize: '200' }, (d, t) =>
        parseMyCouponsMd(typeof d === 'string' ? d : (t ?? '')), []),
      block(userId, 'available-coupons', {}, (d, t) =>
        parseAvailableCouponsMd(typeof d === 'string' ? d : (t ?? '')), []),
    ]);

    res.json({ store: storeRef, card, claimable, storeCoupons: storeBlock });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 4. 积分 / 抽奖 / 奖品 / 商城                                        */
/* ------------------------------------------------------------------ */

explorerRouter.get('/points', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const [account, lottery, prizes] = await Promise.all([
      block(userId, 'query-my-account', {}, parseAccount, undefined),
      block(userId, 'query-lottery-info', {}, parseLottery, undefined),
      block(userId, 'query-my-prizes', { pageNum: '1', pageSize: '20' }, parsePrizes, {
        items: [],
        hasMore: false,
      }),
    ]);
    res.json({ account, lottery, prizes });
  } catch (err) {
    next(err);
  }
});

/**
 * 派对商品列表。
 *
 * 为什么需要这个接口：query-party-city 的 spuId 是必填的，而 spuId
 * 只能从积分商城（mall-points-products）里挑。要求用户自己记住一串
 * 数字 spuId 是不现实的，所以这里直接把商城里的派对类商品筛出来给他选。
 *
 * 判定依据是商品 category —— 实测这四个就是全部派对类目：
 *   生日类派对 / 主题类派对 / 麦麦体验营 / 品鉴会 / 读书会
 */
const PARTY_CATEGORIES = ['生日类派对', '主题类派对', '麦麦体验营', '品鉴会', '读书会'];

explorerRouter.get('/parties/products', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const r = await block(userId, 'mall-points-products', {}, parseMallProducts, []);
    const all = r.data ?? [];
    const products = all
      .filter((p) => PARTY_CATEGORIES.some((c) => (p.category ?? '').includes(c)))
      .map((p) => ({
        spuId: p.spuId,
        name: p.name,
        category: p.category,
        image: p.image,
        points: p.points,
      }));
    res.json({ ...r, data: products, total: products.length });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/mall', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const cat = typeof req.query.cat === 'string' ? req.query.cat : '';
    const args: Record<string, unknown> = {};
    if (cat) args.catRuleIds = cat;
    const r = await block(userId, 'mall-points-products', args, parseMallProducts, []);
    res.json({ ...r, cat });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/mall/:spuId', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const spuId = Number(req.params.spuId);
    if (!Number.isFinite(spuId)) throw new BadRequestError('spuId 必须是数字');
    const r = await block(userId, 'mall-product-detail', { spuId }, parseMallDetail, undefined);
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 5. 订单                                                            */
/* ------------------------------------------------------------------ */

explorerRouter.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const [foodOrders, mallOrders] = await Promise.all([
      block(userId, 'order-list', {}, parseOrderList, []),
      block(userId, 'mall-order-list', { size: 10 }, parseOrderList, []),
    ]);
    res.json({ foodOrders, mallOrders });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/order/:orderId', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const orderId = req.params.orderId;
    if (!orderId) throw new BadRequestError('缺少订单号');
    const kind = req.query.kind === 'mall' ? 'mall' : 'food';

    const [detail, survey] = await Promise.all([
      kind === 'mall'
        ? block(userId, 'mall-order-detail', { orderId }, (d) => {
            const o = (d && typeof d === 'object' ? ((d as Record<string, unknown>).data ?? d) : d) as
              | Record<string, unknown>
              | undefined;
            return o && typeof o === 'object' ? o : undefined;
          }, undefined)
        : block(userId, 'query-order', { orderId }, parseOrder, undefined),
      block(userId, 'query-survey-coupon', { orderId }, (d) => {
        const o = (d && typeof d === 'object' ? ((d as Record<string, unknown>).data ?? d) : d) as
          | Record<string, unknown>
          | undefined;
        if (!o || typeof o !== 'object') return undefined;
        return o;
      }, undefined),
    ]);

    res.json({ kind, detail, survey });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 6. 活动 / 派对                                                     */
/* ------------------------------------------------------------------ */

explorerRouter.get('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const args: Record<string, unknown> = {};
    if (date) args.specifiedDate = date;
    const r = await block(userId, 'campaign-calendar', args, (d, t) =>
      parseCampaignMd(typeof d === 'string' ? d : (t ?? '')), []);
    res.json({ ...r, date });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/parties', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const spuId = num(req.query.spuId);
    // query-party-city 的 spuId 是服务端必填项（不是可选）。
    // 缺了它服务端会返回 {success:false,code:400,message:"缺少参数"}，
    // 与其把这个错误透给用户，不如在这里就说清楚该去哪儿取 spuId。
    if (spuId === undefined) {
      res.json({
        cities: {
          meta: {
            tool: 'query-party-city',
            title: '派对城市',
            cached: false,
            costMs: 0,
            source: 'empty',
            reason: '先选一个派对商品：这个工具必须带 spuId，spuId 来自积分商城的派对类商品',
          },
          data: [],
        },
        spuId: null,
        needSpuId: true,
      });
      return;
    }
    const cities = await block(userId, 'query-party-city', { spuId }, parsePartyCities, []);
    res.json({ cities, spuId });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/parties/stores', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const spuId = num(req.query.spuId);
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    if (!code) throw new BadRequestError('缺少城市 code');

    const args: Record<string, unknown> = { code };
    if (spuId !== undefined) args.spuId = spuId;
    if (lat !== undefined) args.latitude = lat;
    if (lng !== undefined) args.longitude = lng;

    const r = await block(userId, 'query-party-store', args, parsePartyStores, []);
    res.json({ ...r, code });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/parties/dates', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const storeCode = typeof req.query.storeCode === 'string' ? req.query.storeCode : '';
    const spuId = num(req.query.spuId);
    if (!storeCode) throw new BadRequestError('缺少门店编码');
    if (spuId === undefined) throw new BadRequestError('缺少 spuId');

    const r = await block(userId, 'query-party-store-date', { storeCode, spuId }, parsePartyDates, []);
    res.json({ ...r, storeCode, spuId });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/parties/sessions', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const storeCode = typeof req.query.storeCode === 'string' ? req.query.storeCode : '';
    const spuId = num(req.query.spuId);
    const dateStr = typeof req.query.dateStr === 'string' ? req.query.dateStr : '';
    if (!storeCode || !dateStr) throw new BadRequestError('缺少门店编码或日期');
    if (spuId === undefined) throw new BadRequestError('缺少 spuId');

    const r = await block(
      userId,
      'query-party-store-session',
      { storeCode, spuId, dateStr },
      parsePartySessions,
      [],
    );
    res.json({ ...r, storeCode, spuId, dateStr });
  } catch (err) {
    next(err);
  }
});

explorerRouter.get('/addresses', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const r = await block(userId, 'delivery-query-addresses', {}, parseAddresses, []);
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 7. 工具目录 + 工具台                                               */
/* ------------------------------------------------------------------ */

explorerRouter.get('/tools', requireAuth, (_req, res) => {
  res.json({
    groups: TOOL_GROUPS,
    stats: catalogStats(),
    tools: TOOL_CATALOG.map((t) => ({
      ...t,
      ttlText: humanTtl(t.ttlMs),
      /** 网关真实生效的 TTL（可能与目录默认不同，以网关为准） */
      gatewayTtl: READONLY_CACHE_TTL[t.name] ?? 0,
      isWrite: WRITE_TOOLS.has(t.name),
    })),
    rate: rateLimitStats(),
  });
});

const toolCallSchema = z.object({
  args: z.record(z.unknown()).optional(),
  confirm: z.boolean().optional(),
});

explorerRouter.post(
  '/tools/:name',
  requireAuth,
  rateLimit({ limit: 20, scope: 'tool' }),
  async (req, res, next) => {
    try {
      const userId = currentUserId(req);
      const raw = (req.params as Record<string, string | string[]>).name;
      const name = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      if (!name) throw new BadRequestError('缺少工具名');

      const parsed = toolCallSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new BadRequestError('参数格式不对：args 必须是对象');

      const result = await runTool(userId, name, parsed.data.args ?? {}, {
        confirm: parsed.data.confirm === true,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/* 8. 价格试算（前端购物车复核用）                                     */
/* ------------------------------------------------------------------ */

const priceSchema = z.object({
  storeCode: z.string().optional(),
  beType: z.number().int().optional(),
  orderType: z.number().int().optional(),
  items: z
    .array(
      z.object({
        productCode: z.string(),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1)
    .max(30),
});

explorerRouter.post('/price', requireAuth, rateLimit({ limit: 20, scope: 'price' }), async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('items 至少一个商品，数量 1-50');

    let storeCode = parsed.data.storeCode;
    if (!storeCode) {
      const r = await resolveStore(userId);
      storeCode = r.store.storeCode;
    }

    const r = await block(
      userId,
      'calculate-price',
      {
        storeCode,
        orderType: parsed.data.orderType ?? 1,
        beType: parsed.data.beType ?? 1,
        items: parsed.data.items,
      },
      parsePrice,
      undefined,
      { cacheTtl: null, timeoutMs: 20_000 },
    );
    res.json({ ...r, storeCode });
  } catch (err) {
    next(err);
  }
});

void parseStoreCards;
