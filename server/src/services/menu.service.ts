/**
 * 菜单浏览服务 —— 「全部菜单」页的数据源
 *
 * 与对话流水线的区别：
 * - 对话是「一句话 → 一份搭配」，面向意图
 * - 这里是「全量菜单 → 你自己挑」，面向浏览
 *
 * 数据源（实测结构）：
 *   query-meals → data.categories[]{ name, meals[]{code, tags[]} }
 *                 data.meals{ code → {name, image, currentPrice, originalPrice,
 *                                     discountType, canWithOrder} }
 *   · 价格是字符串（"26.5"），amount 单位是元
 *   · canWithOrder=false 表示当前不可售（下架/售罄）
 *   · data.frequent = { code, tags }[]（常点，最多几条）
 */
import { createLogger } from '../lib/logger.js';
import { callTool } from '../mcp/gateway.js';
import { pickString } from '../mcp/toon.js';
import { resolveStore } from './store.service.js';

const log = createLogger('menu');

export interface MenuProduct {
  /** 下单用的商品编码 */
  code: string;
  name: string;
  image?: string;
  /** 现价（元） */
  price: number;
  /** 原价（元），有优惠时才大于 price */
  originalPrice?: number;
  /** 「早餐卡优惠」「促销优惠」等 */
  discountType?: string;
  /** 可下单 */
  available: boolean;
  /** 分类里带的营销标签（「爆款」「韩式辣椒黄油风味」） */
  tags: string[];
}

export interface MenuCategory {
  name: string;
  products: MenuProduct[];
}

export interface MenuResponse {
  store: { storeCode: string; name: string; address?: string; distance?: number; open?: boolean };
  categories: MenuCategory[];
  /** 常点（服务端只给 code，这里补全成商品） */
  frequent: MenuProduct[];
  /** 当前时段 */
  slot: string;
  updatedAt: number;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 当前餐段（麦当劳的售卖时段划分） */
export function currentSlot(now = new Date()): string {
  const h = now.getHours();
  if (h < 10) return '早餐';
  if (h < 14) return '午餐';
  if (h < 17) return '下午茶';
  if (h < 22) return '夜市';
  return '深夜';
}

/**
 * 把 query-meals 的返回解析成前端要的形状。
 * 解析不出来的分类直接跳过 —— 不猜、不补默认图、不编价格。
 */
export function adaptMenu(raw: unknown): {
  categories: MenuCategory[];
  frequent: MenuProduct[];
} {
  if (!raw || typeof raw !== 'object') return { categories: [], frequent: [] };

  const root = raw as Record<string, unknown>;
  const body = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;

  const meals = (body.meals && typeof body.meals === 'object' ? body.meals : {}) as Record<
    string,
    Record<string, unknown>
  >;

  /** code → 商品；map 里存的是「能卖的」 */
  const byCode = new Map<string, MenuProduct>();
  for (const [code, m] of Object.entries(meals)) {
    if (!m || typeof m !== 'object') continue;
    const name = str(m.name);
    if (!name) continue;

    const price = num(m.currentPrice) ?? num(m.price);
    // 没价格没法加购，直接丢（菜单里确实存在少量无价商品）
    if (price === undefined || price <= 0) continue;

    const p: MenuProduct = {
      code,
      name,
      price,
      available: m.canWithOrder !== false,
      tags: [],
    };
    const image = str(m.image);
    if (image) p.image = image;
    const orig = num(m.originalPrice);
    if (orig !== undefined && orig > price) p.originalPrice = orig;
    const disc = str(m.discountType);
    if (disc) p.discountType = disc;
    byCode.set(code, p);
  }

  const categories: MenuCategory[] = [];
  const cats = Array.isArray(body.categories) ? body.categories : [];

  for (const cat of cats) {
    if (!cat || typeof cat !== 'object') continue;
    const c = cat as Record<string, unknown>;
    const catName = str(c.name);
    if (!catName) continue;
    const list = Array.isArray(c.meals) ? c.meals : [];

    const products: MenuProduct[] = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const item = it as Record<string, unknown>;
      const code = str(item.code);
      if (!code) continue;
      const p = byCode.get(code);
      // 分类里列的 code 在 meals 里不存在（无价/下架）→ 跳过
      if (!p) continue;

      // 分类自带的 tags 是营销文案（「爆款」「韩式辣椒黄油风味」），很有价值
      const tags = Array.isArray(item.tags)
        ? item.tags.map((t) => str(t)).filter((t): t is string => Boolean(t))
        : [];

      products.push(tags.length > 0 ? { ...p, tags } : p);
    }

    if (products.length > 0) categories.push({ name: catName, products });
  }

  /* --- 常点 --- */
  const frequent: MenuProduct[] = [];
  const rawFreq = Array.isArray(body.frequent) ? body.frequent : [];
  for (const f of rawFreq) {
    if (!f || typeof f !== 'object') continue;
    const code = pickString(f as Record<string, unknown>, ['code']);
    if (!code) continue;
    const p = byCode.get(code);
    if (p) frequent.push(p);
  }

  return { categories, frequent };
}

/** 对外：全量菜单 */
export async function getMenu(userId: string): Promise<MenuResponse> {
  const { store } = await resolveStore(userId);

  const raw = await callTool(userId, 'query-meals', {
    storeCode: store.storeCode,
    orderType: 1,
    beType: 1,
    ...(store.beCode ? { beCode: store.beCode } : {}),
  });

  const { categories, frequent } = adaptMenu(raw);
  if (categories.length === 0) {
    log.warn(`query-meals 未解析出分类 store=${store.storeCode}`);
  }

  const out: MenuResponse = {
    store: { storeCode: store.storeCode, name: store.name },
    categories,
    frequent,
    slot: currentSlot(),
    updatedAt: Date.now(),
  };
  if (store.address) out.store.address = store.address;
  if (store.distance !== undefined) out.store.distance = store.distance;
  if (store.open !== undefined) out.store.open = store.open;
  return out;
}
