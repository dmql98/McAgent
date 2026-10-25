/**
 * 「MCP 数据面」服务 —— 把 35 个工具的返回，翻译成前端能直接画的结构
 *
 * 为什么需要这一层：
 * 原来的前端只有菜单/券/记忆三个面，35 个工具里 30 个在界面上完全不可见。
 * 而真实返回格式又是四种混着来（JSON / TOON 表 / markdown 卡片 / markdown 表格），
 * 让前端去猜等于把解析 bug 搬到浏览器里。
 *
 * 所以统一在这里做三件事：
 *   1. 调工具（走 gateway，带缓存与限流）
 *   2. 把四类格式归一成数组/对象（解析失败就返回空 + reason，不造假数据）
 *   3. 带上 meta（用的哪个工具、耗时、是否缓存、原始文本前 N 字）
 *
 * 前端拿到 meta 就能在每个区块显示「这条数据是 query-meals 刚查的 / 走的缓存」，
 * 这是「把 MCP 展现出来」最实在的部分 —— 用户看得见数据从哪来。
 */
import { createLogger } from '../lib/logger.js';
import { callToolEnvelope, type CallEnvelope } from '../mcp/gateway.js';
import { parseLoose, pickNumber, pickString, objectMapToArray } from '../mcp/toon.js';
import { parseToonTable, parseMarkdownTable, looseNum } from '../mcp/toon-table.js';
import { TOOL_CATALOG, getTool } from '../mcp/catalog.js';
import { getMemoryService } from './memory.service.js';

const log = createLogger('explorer');

/* ============================================================
 * 通用：调用 + 元信息
 * ============================================================ */

export interface BlockMeta {
  tool: string;
  /** 展示用的中文工具名 */
  title: string;
  cached: boolean;
  costMs: number;
  /** 数据从哪来：mcp=实时、cache=命中缓存、offline=解析失败降级 */
  source: 'mcp' | 'cache' | 'empty';
  /** 服务端原始文本片段（前 600 字），工具台与"原文"折叠区用 */
  rawPreview?: string;
  /** 解析不出数据时的原因，前端直接显示 */
  reason?: string;
}

export interface Block<T> {
  meta: BlockMeta;
  data: T;
}

function baseMeta(tool: string, env: CallEnvelope): BlockMeta {
  const cat = getTool(tool);
  return {
    tool,
    title: cat?.title ?? tool,
    cached: env.cached,
    costMs: env.costMs,
    source: env.cached ? 'cache' : 'mcp',
    ...(env.rawText ? { rawPreview: env.rawText.slice(0, 600) } : {}),
  };
}

/**
 * 统一调用：任何失败都降级为 {data: empty, meta.reason}，绝不把红字甩给用户。
 * 但鉴权失效必须冒泡 —— 那要引导重新粘贴 Token，不能伪装成"没数据"。
 */
async function callBlock<T>(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  parse: (data: unknown, rawText?: string) => T,
  empty: T,
  opts: { cacheTtl?: number | null; timeoutMs?: number } = {},
): Promise<Block<T>> {
  const cat = getTool(tool);
  try {
    const env = await callToolEnvelope(userId, tool, args, opts);
    const parsed = parse(env.data, env.rawText);
    const meta = baseMeta(tool, env);
    if (isEmpty(parsed)) {
      meta.source = 'empty';
      meta.reason = '服务端返回了结果，但没解析出可用条目';
      if (env.rawText) {
        log.debug(`tool=${tool} 未解析出条目，原文前 200：${env.rawText.slice(0, 200)}`);
      }
    }
    return { meta, data: parsed };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED' || code === 'RATE_LIMITED') throw err;
    log.warn(`${tool} 失败（降级为空）：${(err as Error).message}`);
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

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o).length === 0;
  }
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/** 剥掉 {success, code, message, datetime, traceId, data} 外壳 */
function unwrap(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const o = data as Record<string, unknown>;
  if ('data' in o && o.data !== null && o.data !== undefined) return o.data;
  return data;
}

/** 拿一个可能多层的数组 */
function asArray(data: unknown, keys: string[] = ['data', 'list', 'items', 'records']): Array<Record<string, unknown>> {
  const body = unwrap(data);
  if (Array.isArray(body)) {
    // 极端情况：data 是 [ { list: [...] } ]，元素本身不是我们要的条目
    if (body.length === 1 && isObj(body[0])) {
      const inner = body[0];
      for (const k of keys) {
        const v = inner[k];
        if (Array.isArray(v) && v.length && isObj(v[0])) return v.filter(isObj);
      }
    }
    return body.filter(isObj);
  }
  if (!isObj(body)) return [];
  for (const k of keys) {
    const v = body[k];
    if (Array.isArray(v)) {
      // data.list 里再套一层的情况（mall-order-list：data[0].list）
      if (v.length === 1 && isObj(v[0])) {
        const inner = v[0];
        for (const kk of keys) {
          const vv = inner[kk];
          if (Array.isArray(vv) && vv.length && isObj(vv[0])) return vv.filter(isObj);
        }
      }
      return v.filter(isObj);
    }
  }
  // 再深一层（data.list 之类）
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length > 0 && isObj(v[0])) return v.filter(isObj);
  }
  return [];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return looseNum(v);
  return undefined;
}

/**
 * 宽松取字符串。
 *
 * 为什么要接受数字：服务端很多「编码」字段是整数（query-party-city 的
 * city code 就是 610900 这种数字），早先只认 string，结果 281 个城市
 * 全部被当成「没有 code」过滤掉，面板永远空着。
 */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() ? v.trim() : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** 分钟 → 人类可读的缓存时长 */
export function humanTtl(ms: number): string {
  if (!ms) return '不缓存';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 3_600_000)} 小时`;
}

/* ============================================================
 * 1. 门店
 * ============================================================ */

export interface StoreCard {
  storeCode: string;
  name: string;
  address?: string;
  city?: string;
  distance?: number;
  distanceText?: string;
  open?: boolean;
  businessStatus?: string;
  businessHours?: string;
  reservation?: boolean;
  reservationOptions?: string[];
  beCode?: string;
  image?: string;
  tags: string[];
}

/** 附近门店完整卡片（比 store.service 的轻量版多带营业/预约/图片） */
export function parseStoreCards(data: unknown): StoreCard[] {
  const arr = asArray(data, ['data', 'stores', 'storeList', 'list']);
  const out: StoreCard[] = [];

  for (const o of arr) {
    const storeCode = str(o.storeCode) ?? str(o.storeId) ?? str(o.code);
    const name = str(o.storeName) ?? str(o.name) ?? str(o.shopName);
    if (!storeCode || !name) continue;

    const card: StoreCard = { storeCode, name, tags: [] };
    const addr = str(o.address);
    if (addr) card.address = addr;
    const city = str(o.city) ?? str(o.cityName);
    if (city) card.city = city;

    const dist = num(o.distance);
    if (dist !== undefined) {
      card.distance = dist;
      card.distanceText = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`;
    }

    if (typeof o.businessStatus === 'boolean') card.open = o.businessStatus;
    else if (typeof o.businessStatus === 'string') {
      card.businessStatus = o.businessStatus;
      card.open = /营业|open|true/i.test(o.businessStatus) && !/未|closed|false/i.test(o.businessStatus);
    } else if (typeof o.open === 'boolean') card.open = o.open;

    const start = str(o.businessStartTime);
    const end = str(o.businessEndTime);
    if (start || end) card.businessHours = `${start ?? '?'} - ${end ?? '?'}`;

    if (typeof o.reservation === 'boolean') card.reservation = o.reservation;
    const opts = o.reservationTimeOptions;
    if (Array.isArray(opts)) {
      card.reservationOptions = opts
        .map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>).time ?? (x as Record<string, unknown>).text)))
        .filter((x): x is string => Boolean(x));
    }

    const beCode = str(o.beCode);
    if (beCode) card.beCode = beCode;
    const img = str(o.image) ?? str(o.storeImage) ?? str(o.logo);
    if (img) card.image = img;

    // 营业中 / 可预约 / 得来速 这些标签前端直接渲染成 chip
    if (card.open === true) card.tags.push('营业中');
    if (card.open === false) card.tags.push('休息中');
    if (card.reservation) card.tags.push('可预约');
    if (beCode) card.tags.push('得来速');

    out.push(card);
  }
  return out;
}

/** 按城市+关键词搜门店（支撑门店页的搜索框） */
export async function exploreStores(
  userId: string,
  opts: { city?: string; keyword?: string; beType?: number } = {},
): Promise<Block<StoreCard[]> & { city: string; keyword: string; beType: number }> {
  let city = opts.city;
  let keyword = opts.keyword;

  if (!city) {
    const snap = getMemoryService().snapshot(userId);
    city = snap?.usualCity;
    keyword = keyword ?? snap?.usualKeyword ?? snap?.usualStore;
  }

  const beType = opts.beType === 5 ? 5 : 1;
  const args: Record<string, unknown> = {
    beType,
    searchType: 2,
    city: city ?? '',
    keyword: keyword || '麦当劳',
  };

  const block = await callBlock(userId, 'query-nearby-stores', args, parseStoreCards, []);
  return { ...block, city: city ?? '', keyword: String(args.keyword ?? ''), beType };
}

/* ============================================================
 * 2. 菜单
 * ============================================================ */

export interface MenuCard {
  code: string;
  name: string;
  image?: string;
  price: number;
  originalPrice?: number;
  discountType?: string;
  available: boolean;
  tags: string[];
  category?: string;
}

export interface MenuAll {
  categories: Array<{ name: string; items: MenuCard[] }>;
  frequent: MenuCard[];
  total: number;
}

export function parseMenu(data: unknown): MenuAll {
  const body = unwrap(data);
  if (!isObj(body)) return { categories: [], frequent: [], total: 0 };

  const meals = body.meals;
  const list: Array<Record<string, unknown>> = isObj(meals)
    ? objectMapToArray(meals)
    : Array.isArray(meals)
      ? meals.filter(isObj)
      : [];

  const byCode = new Map<string, MenuCard>();
  for (const m of list) {
    const code = str(m.productCode) ?? str(m.code);
    const name = str(m.name) ?? str(m.productName);
    if (!code || !name) continue;
    const price = num(m.currentPrice) ?? num(m.price);
    if (price === undefined) continue;

    const card: MenuCard = {
      code,
      name,
      price,
      available: m.canWithOrder !== false,
      tags: [],
    };
    const img = str(m.image);
    if (img) card.image = img;
    const orig = num(m.originalPrice);
    if (orig !== undefined && orig > price) card.originalPrice = orig;
    const disc = str(m.discountType);
    if (disc) card.discountType = disc;
    byCode.set(code, card);
  }

  /** 分类：{name, meals:[{code, tags[]}]} */
  const categories: Array<{ name: string; items: MenuCard[] }> = [];
  const cats = Array.isArray(body.categories) ? body.categories : [];
  for (const c of cats) {
    if (!isObj(c)) continue;
    const catName = str(c.name);
    if (!catName) continue;
    const refs = Array.isArray(c.meals) ? c.meals : Array.isArray(c.items) ? c.items : [];
    const items: MenuCard[] = [];
    for (const r of refs) {
      if (!isObj(r)) continue;
      const code = str(r.code) ?? str(r.productCode);
      if (!code) continue;
      const p = byCode.get(code);
      if (!p) continue;
      const tags = Array.isArray(r.tags)
        ? r.tags.map((t) => (typeof t === 'string' ? t : str(t))).filter((t): t is string => Boolean(t))
        : [];
      items.push({ ...p, tags, category: catName });
    }
    if (items.length) categories.push({ name: catName, items });
  }

  // 分类缺失时兜底：按"一个小分类"全量展示，避免整页空白
  if (categories.length === 0 && byCode.size > 0) {
    categories.push({ name: '全部餐品', items: [...byCode.values()] });
  }

  const frequent: MenuCard[] = [];
  if (Array.isArray(body.frequent)) {
    for (const f of body.frequent) {
      if (!isObj(f)) continue;
      const code = str(f.code) ?? str(f.productCode);
      const p = code ? byCode.get(code) : undefined;
      if (p) frequent.push(p);
    }
  }

  return { categories, frequent, total: byCode.size };
}

export interface MealDetail {
  code: string;
  name: string;
  image?: string;
  description?: string;
  supportModify: boolean;
  /** 特制分组：第几轮 / 可选什么 */
  rounds: Array<{
    name: string;
    choices: Array<{
      code?: string;
      name: string;
      isDefault: boolean;
      diffPrice?: string;
      supportModify: boolean;
      options: Array<{ name: string; diffPrice?: string; default?: boolean }>;
    }>;
  }>;
  /** 套餐组成 */
  combo: Array<{ name: string; quantity?: number; image?: string }>;
}

export function parseMealDetail(data: unknown): MealDetail | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  const name = str(body.name);
  if (!name) return undefined;

  const detail: MealDetail = {
    code: str(body.code) ?? '',
    name,
    supportModify: body.supportModify === true,
    rounds: [],
    combo: [],
  };
  const img = str(body.image);
  if (img) detail.image = img;
  const desc = str(body.description) ?? str(body.desc);
  if (desc) detail.description = desc;

  const rounds = Array.isArray(body.rounds) ? body.rounds : [];
  for (const [ri, r] of rounds.entries()) {
    if (!isObj(r)) continue;
    const choices = Array.isArray(r.choices) ? r.choices : [];
    const outChoices: MealDetail['rounds'][number]['choices'] = [];

    for (const ch of choices) {
      if (!isObj(ch)) continue;
      const chName = str(ch.name);
      if (!chName) continue;
      const item = {
        name: chName,
        isDefault: ch.isDefault === true || ch.isDefault === 1,
        supportModify: ch.supportModify === true,
        options: [] as Array<{ name: string; diffPrice?: string; default?: boolean }>,
      } as MealDetail['rounds'][number]['choices'][number];
      const code = str(ch.code);
      if (code) item.code = code;
      const diff = str(ch.diffPrice);
      if (diff) item.diffPrice = diff;

      /**
       * 实测结构：modification.items[].values[]
       * 每个 value 里带 selectedKey/unselectedKey（下单时传的两个键），
       * 名字在 name/valueName 上。
       */
      const mod = isObj(ch.modification) ? ch.modification : undefined;
      const modItems = mod && Array.isArray(mod.items) ? mod.items : [];
      for (const mi of modItems) {
        if (!isObj(mi)) continue;
        const values = Array.isArray(mi.values) ? mi.values : [];
        for (const v of values) {
          if (!isObj(v)) continue;
          const vName = str(v.name) ?? str(v.valueName) ?? str(v.label);
          if (!vName) continue;
          const opt: { name: string; diffPrice?: string; default?: boolean } = { name: vName };
          const vd = str(v.diffPrice);
          if (vd) opt.diffPrice = vd;
          if (v.isDefault === true || v.isDefault === 1) opt.default = true;
          item.options.push(opt);
        }
      }
      outChoices.push(item);
    }

    if (outChoices.length) {
      detail.rounds.push({ name: str(r.name) ?? str(r.title) ?? `第 ${ri + 1} 轮`, choices: outChoices });
    }
  }

  // 套餐组成（有些餐品叫 comboItemList / items）
  const comboRaw = body.combo ?? body.comboItems ?? body.comboItemList ?? body.items;
  if (Array.isArray(comboRaw)) {
    for (const c of comboRaw) {
      if (!isObj(c)) continue;
      const cName = str(c.name) ?? str(itemNameOf(c));
      if (!cName) continue;
      const entry: { name: string; quantity?: number; image?: string } = { name: cName };
      const q = num(c.quantity) ?? num(c.itemQuantity);
      if (q !== undefined) entry.quantity = q;
      const cImg = str(c.image);
      if (cImg) entry.image = cImg;
      detail.combo.push(entry);
    }
  }

  return detail;
}

function itemNameOf(o: Record<string, unknown>): string | undefined {
  return str(o.itemName) ?? str(o.productName);
}

/** 营养表（TOON / md 表 / JSON 三种都能吃） */
export interface NutritionRow {
  productName: string;
  nutritionDescription?: string;
  energyKcal?: number;
  energyKj?: number;
  protein?: number;
  fat?: number;
  carbohydrate?: number;
  sodium?: number;
  calcium?: number;
}

export function parseNutrition(data: unknown, rawText?: string): NutritionRow[] {
  // ① TOON 表可能藏在两个地方，都要试：
  //    a. 整段 rawText 就是 TOON（少见的实现）
  //    b. JSON 信封的 data 字段是个 TOON 字符串 —— 营养表实测就是这种：
  //       {"success":true,...,"data":"[160]{productName,energyKcal,...}:\n  巨无霸,500,..."}
  const candidates: string[] = [];
  if (rawText) candidates.push(rawText);
  const inner = unwrap(data);
  if (typeof inner === 'string') candidates.push(inner);
  if (typeof data === 'string') candidates.push(data);

  for (const text of candidates) {
    const table = parseToonTable(text);
    if (table && table.rows.length) {
      const rows = table.rows.map((r) => toNutritionRow(r)).filter((r): r is NutritionRow => Boolean(r));
      if (rows.length) return rows;
    }
    const md = parseMarkdownTable(text);
    if (md.length) {
      const rows = md.map((r) => toNutritionRow(r)).filter((r): r is NutritionRow => Boolean(r));
      if (rows.length) return rows;
    }
  }

  // ② JSON 数组
  const arr = Array.isArray(inner)
    ? inner.filter(isObj)
    : asArray(data, ['data', 'foods', 'nutrition', 'list', 'items']);
  return arr.map((o) => toNutritionRow(o as Record<string, unknown>)).filter((r): r is NutritionRow => Boolean(r));
}

function toNutritionRow(o: Record<string, unknown>): NutritionRow | undefined {
  const name = str(o.productName) ?? str(o.name) ?? str(o.foodName);
  if (!name) return undefined;
  const row: NutritionRow = { productName: name };
  const desc = str(o.nutritionDescription) ?? str(o.description) ?? str(o.desc);
  if (desc) row.nutritionDescription = desc;

  // 键名可能是 energyKcal / energy(kcal) / 能量(千卡) —— 统一宽松匹配
  const kcal = num(o.energyKcal) ?? num(o.kcal) ?? num(o.calories);
  if (kcal !== undefined) row.energyKcal = kcal;
  const kj = num(o.energyKj) ?? num(o.kj);
  if (kj !== undefined) row.energyKj = kj;
  const protein = num(o.protein);
  if (protein !== undefined) row.protein = protein;
  const fat = num(o.fat);
  if (fat !== undefined) row.fat = fat;
  const carb = num(o.carbohydrate) ?? num(o.carb);
  if (carb !== undefined) row.carbohydrate = carb;
  const sodium = num(o.sodium);
  if (sodium !== undefined) row.sodium = sodium;
  const calcium = num(o.calcium);
  if (calcium !== undefined) row.calcium = calcium;

  return row;
}

/* ============================================================
 * 3. 优惠券
 * ============================================================ */

export interface CouponCard {
  id: string;
  title: string;
  /** 用券价 / 面额（元） */
  price?: number;
  priceNote?: string;
  validity?: string;
  receivedAt?: string;
  tags: string[];
  image?: string;
  status?: string;
  code?: string;
  products?: string[];
  /** 卡包 / 可领 / 门店券 */
  kind: 'card' | 'claimable' | 'store';
  raw?: string;
}

export function parseMyCouponsMd(text: string): CouponCard[] {
  if (!text || typeof text !== 'string') return [];
  const blocks = splitByHeading(text, /^##\s+(.+?)\s*$/gm);
  const out: CouponCard[] = [];

  for (const [i, b] of blocks.entries()) {
    const title = b.title.replace(/\\\s*$/, '').trim();
    if (!title || /优惠券列表|^列表$/.test(title)) continue;
    if (!/<img|优惠|有效期|券/.test(b.body)) continue;

    const card: CouponCard = { id: `card-${i}`, title, tags: [], kind: 'card' };

    const priceRaw = mdField(b.body, '优惠') ?? mdField(b.body, '用券价格') ?? mdField(b.body, '面额');
    if (priceRaw) {
      const m = priceRaw.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
      if (m?.[1]) card.price = Number(m[1]);
      const note = priceRaw.match(/[(（]([^)）]+)[)）]/);
      card.priceNote = note?.[1]?.trim() || priceRaw;
    }

    const validity = mdField(b.body, '有效期');
    if (validity) card.validity = validity;
    const received = mdField(b.body, '领取时间');
    if (received) card.receivedAt = received;
    const tags = mdField(b.body, '标签');
    if (tags) card.tags = splitTags(tags);
    const status = mdField(b.body, '状态');
    if (status) card.status = status;

    const img = b.body.match(/<img[^>]*\ssrc="([^"]+)"/);
    if (img?.[1]) card.image = img[1];

    card.raw = b.body.trim().slice(0, 500);
    out.push(card);
  }
  return out;
}

export function parseAvailableCouponsMd(text: string): CouponCard[] {
  if (!text || typeof text !== 'string') return [];
  const blocks = splitByHeading(text, /^-\s*优惠券标题\s*[:：]\s*(.+)$/gm);
  const out: CouponCard[] = [];

  for (const [i, b] of blocks.entries()) {
    const title = b.title.replace(/\\\s*$/, '').trim();
    if (!title) continue;
    const card: CouponCard = { id: `claim-${i}`, title, tags: [], kind: 'claimable' };

    const status = b.body.match(/状态\s*[:：]\s*([^\n\\|]+)/);
    if (status?.[1]) card.status = status[1].trim();
    const tags = b.body.match(/标签\s*[:：]\s*([^\n\\|]+)/);
    if (tags?.[1]) card.tags = splitTags(tags[1]);
    const validity = b.body.match(/有效期\s*[:：]\s*([^\n\\|]+)/);
    if (validity?.[1]) card.validity = validity[1].trim();
    const price = b.body.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    if (price?.[1]) card.price = Number(price[1]);

    const img = b.body.match(/<img[^>]*\ssrc="([^"]+)"/);
    if (img?.[1]) card.image = img[1];

    card.raw = b.body.trim().slice(0, 400);
    out.push(card);
  }
  return out;
}

export function parseStoreCoupons(data: unknown): CouponCard[] {
  const arr = asArray(data, ['data', 'list', 'coupons']);
  const out: CouponCard[] = [];
  for (const [i, o] of arr.entries()) {
    const title = str(o.title) ?? str(o.couponName) ?? str(o.name);
    if (!title) continue;
    const card: CouponCard = {
      id: pickString(o, ['couponId', 'id']) ?? `store-${i}`,
      title,
      tags: [],
      kind: 'store',
    };
    const validity = pickString(o, ['tradeDateTime', 'validity', 'expireTime']);
    if (validity) card.validity = validity;
    const code = pickString(o, ['couponCode']);
    if (code) card.code = code;
    const products = Array.isArray(o.products)
      ? o.products.map((p) => pickString(p, ['productName', 'name'])).filter((x): x is string => Boolean(x))
      : [];
    if (products.length) {
      card.products = products;
      card.tags = [products.length > 1 ? `适用 ${products.length} 款` : products[0]!];
    }
    const amt = num(o.amount) ?? num(o.discountAmount) ?? num(o.faceValue);
    if (amt !== undefined) card.price = amt;
    out.push(card);
  }
  return out;
}

/* markdown 小工具 */
function mdField(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`\\*\\*${key}\\*\\*\\s*[:：]\\s*(.+)`)) ?? body.match(new RegExp(`${key}\\s*[:：]\\s*(.+)`));
  return m?.[1]?.trim();
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[、,，·/|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function splitByHeading(text: string, heading: RegExp): Array<{ title: string; body: string }> {
  const matches = [...text.matchAll(heading)];
  const out: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const start = (cur.index ?? 0) + cur[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    out.push({ title: (cur[1] ?? '').trim(), body: text.slice(start, end) });
  }
  return out;
}

/* ============================================================
 * 4. 积分 / 抽奖 / 奖品 / 商城
 * ============================================================ */

export interface AccountInfo {
  available: number;
  expiringThisMonth: number;
  accumulated: number;
  used: number;
  expired: number;
  frozen: number;
  level?: string;
  memberNo?: string;
}

export function parseAccount(data: unknown): AccountInfo | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  if (!('availablePoint' in body) && !('availablePoints' in body) && !('point' in body)) return undefined;

  const info: AccountInfo = {
    available: num(body.availablePoint) ?? num(body.availablePoints) ?? num(body.point) ?? 0,
    // ⚠️ 服务端拼写是 Mouth（不是 Month）
    expiringThisMonth: num(body.currentMouthExpirePoint) ?? num(body.currentMonthExpirePoint) ?? 0,
    accumulated: num(body.accumulativePoint) ?? num(body.accumulatedPoint) ?? 0,
    used: num(body.usedPoint) ?? 0,
    expired: num(body.expiredPoint) ?? 0,
    frozen: num(body.frozenPoint) ?? 0,
  };
  const level = str(body.levelName) ?? str(body.memberLevel);
  if (level) info.level = level;
  const no = str(body.memberNo) ?? str(body.cardNo);
  if (no) info.memberNo = no;
  return info;
}

export interface LotteryInfo {
  activityName?: string;
  activityCode?: string;
  status?: string;
  beginTime?: string;
  endTime?: string;
  drawPoint?: number;
  drawTypeText?: string;
  availableTimes?: number;
  availablePoint?: number;
  /** 服务端算的资源决策 —— 能不能抽、这次扣什么 */
  decision?: {
    eligible?: boolean;
    eligibleText?: string;
    nextConsumption?: string;
    fallback?: string;
  };
  prizes: Array<{ name: string; image?: string; typeText?: string }>;
}

export function parseLottery(data: unknown): LotteryInfo | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  if (!body.activityCode && !body.activityName && !body.prizes) return undefined;

  const info: LotteryInfo = { prizes: [] };
  const name = str(body.activityName);
  if (name) info.activityName = name;
  const code = str(body.activityCode);
  if (code) info.activityCode = code;
  const status = str(body.activityStatusText) ?? str(body.statusText) ?? str(body.status);
  if (status) info.status = status;
  const begin = str(body.beginTime);
  if (begin) info.beginTime = begin;
  const end = str(body.endTime);
  if (end) info.endTime = end;
  const dp = num(body.drawPoint);
  if (dp !== undefined) info.drawPoint = dp;
  const dt = str(body.drawTypeText);
  if (dt) info.drawTypeText = dt;
  const at = num(body.availableTimes);
  if (at !== undefined) info.availableTimes = at;
  const ap = num(body.availablePoint);
  if (ap !== undefined) info.availablePoint = ap;

  const dd = body.drawDecision;
  if (isObj(dd)) {
    info.decision = {};
    if (typeof dd.resourceEligible === 'boolean') info.decision.eligible = dd.resourceEligible;
    const et = str(dd.eligibleText) ?? str(dd.resourceEligibleText);
    if (et) info.decision.eligibleText = et;
    const nc = dd.nextConsumption;
    if (isObj(nc)) {
      const t = str(nc.type);
      const v = num(nc.value) ?? num(nc.amount);
      info.decision.nextConsumption = [t, v !== undefined ? `×${v}` : ''].filter(Boolean).join(' ');
    } else if (typeof nc === 'string') {
      info.decision.nextConsumption = nc;
    }
    const fc = dd.fallbackConsumption;
    if (isObj(fc)) {
      info.decision.fallback = str(fc.type) ?? '';
    }
  }

  const prizes = Array.isArray(body.prizes) ? body.prizes : [];
  for (const p of prizes) {
    if (!isObj(p)) continue;
    const pn = str(p.name) ?? str(p.prizeName);
    if (!pn) continue;
    const entry: { name: string; image?: string; typeText?: string } = { name: pn };
    const img = str(p.imageUrl) ?? str(p.image);
    if (img) entry.image = img;
    const tt = str(p.typeText);
    if (tt) entry.typeText = tt;
    info.prizes.push(entry);
  }
  return info;
}

export interface PrizeItem {
  id: string;
  name: string;
  image?: string;
  status?: string;
  time?: string;
  remind?: string;
  typeText?: string;
}

export function parsePrizes(data: unknown): { items: PrizeItem[]; hasMore: boolean } {
  const body = unwrap(data);
  const arr = Array.isArray(body) ? body.filter(isObj) : asArray(body, ['prizes', 'data', 'list', 'items']);
  const items: PrizeItem[] = [];
  for (const [i, o] of arr.entries()) {
    const name = str(o.name) ?? str(o.prizeName);
    if (!name) continue;
    const it: PrizeItem = { id: str(o.id) ?? `prize-${i}`, name };
    const img = str(o.imageUrl) ?? str(o.image);
    if (img) it.image = img;
    const st = str(o.statusText) ?? str(o.status);
    if (st) it.status = st;
    const t = str(o.recordTime) ?? str(o.time);
    if (t) it.time = t;
    const r = str(o.timeRemindText);
    if (r) it.remind = r;
    const tt = str(o.prizeType);
    if (tt) it.typeText = tt;
    items.push(it);
  }
  const hasMore = isObj(body) && body.hasMore === true;
  return { items, hasMore };
}

export interface MallProduct {
  spuId?: number | string;
  name: string;
  image?: string;
  points?: number;
  originalPoints?: number;
  category?: string;
  desc?: string;
  stock?: number;
  tags: string[];
}

export function parseMallProducts(data: unknown): MallProduct[] {
  const arr = asArray(data, ['data', 'list', 'products', 'items', 'records']);
  const out: MallProduct[] = [];
  for (const o of arr) {
    const name = str(o.name) ?? str(o.spuName) ?? str(o.productName) ?? str(o.title);
    if (!name) continue;
    const p: MallProduct = { name, tags: [] };
    const spu = num(o.spuId) ?? str(o.spuId);
    if (spu !== undefined) p.spuId = spu;
    const img = str(o.image) ?? str(o.imageUrl) ?? str(o.picUrl);
    if (img) p.image = img;
    const pts = num(o.points) ?? num(o.point) ?? num(o.salePoint) ?? num(o.price);
    if (pts !== undefined) p.points = pts;
    const orig = num(o.originalPoints) ?? num(o.marketPoint);
    if (orig !== undefined && p.points !== undefined && orig > p.points) p.originalPoints = orig;
    const cat = str(o.categoryName) ?? str(o.catName) ?? str(o.typeName);
    if (cat) p.category = cat;
    const desc = str(o.description) ?? str(o.desc) ?? str(o.summary);
    if (desc) p.desc = desc;
    const stock = num(o.stock) ?? num(o.inventory);
    if (stock !== undefined) p.stock = stock;
    if (Array.isArray(o.tags)) {
      p.tags = o.tags.map((t) => (typeof t === 'string' ? t : str(t))).filter((t): t is string => Boolean(t));
    }
    out.push(p);
  }
  return out;
}

export interface MallProductDetail {
  spuId?: number | string;
  name: string;
  image?: string;
  description?: string;
  images: string[];
  skus: Array<{ skuId?: number | string; name?: string; points?: number; stock?: number; spec?: string }>;
}

export function parseMallDetail(data: unknown): MallProductDetail | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  const name = str(body.name) ?? str(body.spuName) ?? str(body.title);
  if (!name) return undefined;

  const out: MallProductDetail = { name, images: [], skus: [] };
  const spu = num(body.spuId) ?? str(body.spuId);
  if (spu !== undefined) out.spuId = spu;
  const img = str(body.image) ?? str(body.imageUrl);
  if (img) out.image = img;
  const desc = str(body.description) ?? str(body.desc);
  if (desc) out.description = desc;

  if (Array.isArray(body.images)) {
    out.images = body.images.map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>).url))).filter((x): x is string => Boolean(x));
  }

  const skus = Array.isArray(body.skus) ? body.skus : Array.isArray(body.skuList) ? body.skuList : [];
  for (const s of skus) {
    if (!isObj(s)) continue;
    const entry: { skuId?: number | string; name?: string; points?: number; stock?: number; spec?: string } = {};
    const id = num(s.skuId) ?? str(s.skuId);
    if (id !== undefined) entry.skuId = id;
    const sn = str(s.name) ?? str(s.skuName);
    if (sn) entry.name = sn;
    const pts = num(s.points) ?? num(s.point) ?? num(s.price);
    if (pts !== undefined) entry.points = pts;
    const stock = num(s.stock) ?? num(s.inventory);
    if (stock !== undefined) entry.stock = stock;
    const spec = str(s.spec) ?? str(s.specName);
    if (spec) entry.spec = spec;
    if (Object.keys(entry).length) out.skus.push(entry);
  }
  return out;
}

/* ============================================================
 * 5. 订单
 * ============================================================ */

export interface OrderItemCard {
  name: string;
  quantity?: number;
  price?: number;
  /** 商城订单用积分计价，不是金额 */
  points?: number;
  image?: string;
  combo?: string[];
}

export interface OrderCard {
  orderId: string;
  status?: string;
  statusText?: string;
  storeName?: string;
  storeAddress?: string;
  total?: number;
  realTotal?: number;
  /** 商城订单没有金额，只有件数 */
  totalCount?: number;
  createdAt?: string;
  payUrl?: string;
  items: OrderItemCard[];
  extra: Array<{ label: string; value: string }>;
}

const ORDER_STATUS_TEXT: Record<string, string> = {
  '1': '待支付',
  '2': '配餐中（已支付）',
  '4': '配送中',
  '6': '已完成',
  '7': '已取消',
  '8': '已评价',
  '10': '配餐中（餐厅确认）',
};

export function orderStatusText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const key = String(raw);
  return ORDER_STATUS_TEXT[key] ?? (typeof raw === 'string' ? raw : undefined);
}

export function parseOrder(data: unknown): OrderCard | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  const orderId = str(body.orderId) ?? str(body.orderNo) ?? str(body.orderCode);
  if (!orderId) return undefined;

  const card: OrderCard = { orderId, items: [], extra: [] };
  // orderStatusTitle 是商城订单的字段名（mall-order-list 实测用这个），
  // 餐品订单才用 statusText。两个都要认，否则商城订单状态全是空。
  const st = str(body.statusText) ?? str(body.orderStatusTitle);
  const statusRaw = body.orderStatus ?? body.status;
  if (st) card.statusText = st;
  else {
    const t = orderStatusText(statusRaw);
    if (t) card.statusText = t;
  }
  if (statusRaw !== undefined) card.status = String(statusRaw);
  // 商城订单没有金额，只有件数
  const tc = num(body.totalCount);
  if (tc !== undefined) card.totalCount = tc;

  const sn = str(body.storeName);
  if (sn) card.storeName = sn;
  const sa = str(body.storeAddress);
  if (sa) card.storeAddress = sa;

  const total = num(body.totalAmount) ?? num(body.total);
  if (total !== undefined) card.total = total;
  const real = num(body.realTotalAmount) ?? num(body.payAmount) ?? num(body.price);
  if (real !== undefined) card.realTotal = real;

  const ct = str(body.createTime) ?? str(body.createdAt);
  if (ct) card.createdAt = ct;
  const pu = str(body.payUrl);
  if (pu) card.payUrl = pu;

  const list = Array.isArray(body.orderProductList)
    ? body.orderProductList
    : Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.goods) // 商城订单用 goods
        ? body.goods
        : [];
  for (const p of list) {
    if (!isObj(p)) continue;
    // 商城订单是 spuName/skuName，餐品订单是 productName/name
    const name = str(p.productName) ?? str(p.name) ?? str(p.spuName);
    if (!name) continue;
    const item: OrderItemCard = { name };
    const q = num(p.quantity) ?? num(p.count);
    if (q !== undefined) item.quantity = q;
    const price = num(p.price) ?? num(p.amount);
    if (price !== undefined) item.price = price;
    // 商城订单用积分而不是金额
    const pts = num(p.points);
    if (pts !== undefined) item.points = pts;
    const img = str(p.productImage) ?? str(p.image);
    if (img) item.image = img;
    const combo = Array.isArray(p.comboItemList)
      ? p.comboItemList
          .map((c) => {
            if (!isObj(c)) return undefined;
            const n = str(c.itemName) ?? str(c.name);
            const qq = num(c.itemQuantity);
            return n ? (qq && qq > 1 ? `${n} ×${qq}` : n) : undefined;
          })
          .filter((x): x is string => Boolean(x))
      : [];
    if (combo.length) item.combo = combo;
    card.items.push(item);
  }

  // 其余标量字段收进 extra，保证"服务端给了什么都能看到"
  const known = new Set([
    'orderId', 'orderNo', 'orderCode', 'status', 'orderStatus', 'statusText',
    'storeName', 'storeAddress', 'totalAmount', 'total', 'realTotalAmount', 'payAmount', 'price',
    'createTime', 'createdAt', 'payUrl', 'orderProductList', 'items',
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (known.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    card.extra.push({ label: k, value: String(v) });
  }

  return card;
}

export function parseOrderList(data: unknown): OrderCard[] {
  const arr = asArray(data, ['data', 'list', 'orders', 'items', 'records']);
  const out: OrderCard[] = [];
  for (const o of arr) {
    const card = parseOrder(o);
    if (card) out.push(card);
  }
  return out;
}

/* ============================================================
 * 6. 活动日历 / 派对
 * ============================================================ */

export interface CampaignDay {
  date: string;
  label?: string;
  activities: Array<{ title: string; desc?: string; image?: string; timeText?: string; tags: string[] }>;
}

/**
 * campaign-calendar 实测返回的 markdown 有两种排版，必须都认：
 *
 * ① 实测真实格式（2026-10 抓到的）：
 *      ### 当前时间：2026-10-24 15:38:15
 *      ### 活动列表：
 *      #### 2026年10月20日 往期回顾
 *      -   **活动标题**：麦当劳 X PEACEMINUSONE
 *          **活动内容介绍**：…
 *          <img src="...">
 *
 * ② 早期文档里写的简化格式：
 *      ## 10月24日（今日）
 *      ### 活动标题
 *      活动介绍…
 *
 * 关键差异：日期行是 4 级标题（####），活动标题不是标题而是 `- **活动标题**：`。
 * 早期实现只认 `#{1,2}`，所以真实返回一条都解析不出来 —— 这就是
 * 「服务端返回了内容，但没能解析出条目」的来源。
 */
export function parseCampaignMd(text: string): CampaignDay[] {
  if (!text || typeof text !== 'string') return [];

  // 任意级标题都切一刀，之后再决定它是「日期行」还是「活动子标题」。
  // 不能直接用日期正则切：那样 `### 霜降品鉴会` 会把上一天的正文截断，
  // 导致日期块拿到空 body、活动全丢（这正是之前 0 天的原因）。
  const nodes = splitByHeading(text, /^#{1,6}\s*(.+?)\s*$/gm);
  const isDateTitle = (t: string): boolean =>
    /\d{4}\s*年\s*\d{1,2}\s*月|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}|今日|往期|未来|进行中/.test(t);

  /** 粗切出来的「一天」：日期标题 + 它下面所有（含子标题的）正文 */
  const rawDays: Array<{ title: string; body: string }> = [];
  for (const n of nodes) {
    if (isDateTitle(n.title)) {
      rawDays.push({ title: n.title, body: n.body });
    } else if (rawDays.length > 0) {
      // 非日期标题（`### 活动标题`）：把标题行重新拼回上一天的正文里
      const prev = rawDays[rawDays.length - 1]!;
      prev.body += `\n### ${n.title}\n${n.body}`;
    }
  }

  const out: CampaignDay[] = [];
  for (const d of rawDays) {
    const labelM = d.title.match(/[（(]([^)）]+)[)）]/);
    const day: CampaignDay = { date: d.title.trim(), activities: [] };
    // 「2026年10月20日 往期回顾」→ label = 往期回顾
    const tailM =
      d.title.match(/\d{1,2}\s*月\s*\d{1,2}\s*日\s*(.+)$/) ??
      d.title.match(/^(今日|往期回顾|往期|未来|进行中)\s*(.*)$/);
    const label = labelM?.[1]?.trim() ?? tailM?.[1]?.trim();
    if (label) day.label = label;

    // 活动：① `- **活动标题**：xxx`  ② `### xxx`
    const acts = splitCampaignActivities(d.body);
    for (const a of acts) {
      if (!a.title) continue;
      const entry: CampaignDay['activities'][number] = { title: a.title, tags: [] };
      const img = a.body.match(/<img[^>]*\ssrc="([^"]+)"/);
      if (img?.[1]) entry.image = img[1];
      const timeM = a.body.match(/(\d{1,2}:\d{2}\s*[-~到至]\s*\d{1,2}:\d{2})/);
      if (timeM?.[1]) entry.timeText = timeM[1];
      const desc = firstMeaningfulLine(a.body);
      if (desc) entry.desc = desc.slice(0, 160);
      for (const tag of ['进行中', '往期', '未来', '可订阅', '已订阅']) {
        if (d.title.includes(tag) || a.body.includes(tag) || a.title.includes(tag)) {
          if (!entry.tags.includes(tag)) entry.tags.push(tag);
        }
      }
      day.activities.push(entry);
    }
    if (day.activities.length) out.push(day);
  }
  return out;
}

/** 把一个日期块里的活动拆出来，兼容两种排版 */
function splitCampaignActivities(body: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];

  // ② 标题式：`### 活动标题`
  const byHeading = splitByHeading(body, /^#{3,6}\s+(.+?)\s*$/gm);
  if (byHeading.length > 0) {
    for (const h of byHeading) {
      const t = h.title.trim();
      // 跳过 "当前时间：xxx" / "活动列表：" 这类非活动标题
      if (!t || /^(当前时间|活动列表|活动日历)[:：]?/.test(t)) continue;
      out.push({ title: t, body: h.body });
    }
    if (out.length) return out;
  }

  // ① 列表式：`-   **活动标题**：xxx`
  const lines = body.split('\n');
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\*\*\s*活动标题\s*\*\*\s*[:：]\s*(.+)$/);
    if (m?.[1]) {
      if (cur) out.push({ title: cur.title.trim(), body: cur.lines.join('\n') });
      cur = { title: m[1].trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ title: cur.title.trim(), body: cur.lines.join('\n') });
  return out;
}

/** 取正文里第一条有意义的文字（跳过图片、空行、纯标点、字段名残留） */
function firstMeaningfulLine(body: string): string | undefined {
  const cleaned = body
    .replace(/<img[^>]*>/g, '')
    .split(/\n/)
    // 逐行剥掉：列表符号 → 字段名（允许字段名两侧都带 ** ） → 残留的粗体标记
    .map((s) =>
      s
        .replace(/^[-*>#\s]+/, '')
        .replace(/^\*{0,2}\s*(活动图片介绍|活动内容介绍|活动标题)\s*\*{0,2}\s*[:：]?\s*/, '')
        .replace(/^\*+/, '')
        .trim(),
    )
    .filter((s) => s && !/^!\[/.test(s) && s.length > 4);
  return cleaned[0];
}


export interface PartyCity {
  code: string;
  name: string;
  latitude?: number;
  longitude?: number;
}

export function parsePartyCities(data: unknown): PartyCity[] {
  const arr = asArray(data, ['data', 'list', 'cities', 'items']);
  const out: PartyCity[] = [];
  for (const o of arr) {
    const name = str(o.name) ?? str(o.cityName);
    const code = str(o.code) ?? str(o.cityCode);
    if (!name || !code) continue;
    const c: PartyCity = { code, name };
    const lat = num(o.latitude);
    const lng = num(o.longitude);
    if (lat !== undefined) c.latitude = lat;
    if (lng !== undefined) c.longitude = lng;
    out.push(c);
  }
  return out;
}

export interface PartyStore {
  storeCode: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export function parsePartyStores(data: unknown): PartyStore[] {
  const arr = asArray(data, ['data', 'list', 'stores', 'items']);
  const out: PartyStore[] = [];
  for (const o of arr) {
    const code = str(o.storeCode) ?? str(o.code);
    const name = str(o.storeName) ?? str(o.name);
    if (!code || !name) continue;
    const s: PartyStore = { storeCode: code, name };
    const addr = str(o.address);
    if (addr) s.address = addr;
    const lat = num(o.latitude);
    const lng = num(o.longitude);
    if (lat !== undefined) s.latitude = lat;
    if (lng !== undefined) s.longitude = lng;
    out.push(s);
  }
  return out;
}

export interface PartyDate {
  date: string;
  weekday?: string;
  available?: boolean;
  tag?: string;
}

export function parsePartyDates(data: unknown): PartyDate[] {
  const arr = asArray(data, ['data', 'list', 'dates', 'items']);
  const out: PartyDate[] = [];
  for (const o of arr) {
    const date = str(o.dateStr) ?? str(o.date);
    if (!date) continue;
    const d: PartyDate = { date };
    const w = str(o.weekday) ?? str(o.week);
    if (w) d.weekday = w;
    if (typeof o.available === 'boolean') d.available = o.available;
    const tag = str(o.tag) ?? str(o.statusText);
    if (tag) d.tag = tag;
    out.push(d);
  }
  return out;
}

export interface PartySession {
  sessionId?: string;
  name: string;
  startTime?: string;
  endTime?: string;
  price?: number;
  /** 剩余名额（服务端字段 leftNum） */
  stock?: number;
  /** 成团人数下限（partyMin） */
  minPeople?: number;
  /** 成团人数上限（partyMax） */
  maxPeople?: number;
  status?: string;
}

export function parsePartySessions(data: unknown): PartySession[] {
  const arr = asArray(data, ['data', 'list', 'sessions', 'items']);
  const out: PartySession[] = [];
  for (const o of arr) {
    // 实测字段：{id, timeStart, timeEnd, partyMin, partyMax, price, leftNum}
    // 没有 name 这种字段，场次的"名字"就是时间段，所以要自己拼。
    const id = str(o.id) ?? str(o.sessionId);
    const st = str(o.timeStart) ?? str(o.startTime) ?? str(o.beginTime);
    const et = str(o.timeEnd) ?? str(o.endTime);
    const givenName = str(o.name) ?? str(o.sessionName) ?? str(o.title);

    const name = givenName ?? (st ? (et ? `${st}-${et}` : st) : undefined);
    if (!name) continue;

    const s: PartySession = { name };
    if (id) s.sessionId = id;
    if (st) s.startTime = st;
    if (et) s.endTime = et;

    const price = num(o.price) ?? num(o.points) ?? num(o.point);
    if (price !== undefined) s.price = price;
    // leftNum=剩余场次名额，比 stock/remaining 更贴近实际字段
    const stock = num(o.leftNum) ?? num(o.stock) ?? num(o.remaining);
    if (stock !== undefined) s.stock = stock;
    const min = num(o.partyMin);
    if (min !== undefined) s.minPeople = min;
    const max = num(o.partyMax);
    if (max !== undefined) s.maxPeople = max;

    const status = str(o.statusText) ?? str(o.status);
    if (status) s.status = status;
    out.push(s);
  }
  return out;
}

/* ============================================================
 * 7. 外送地址
 * ============================================================ */

export interface AddressCard {
  addressId: string;
  contactName?: string;
  phone?: string;
  city?: string;
  address?: string;
  detail?: string;
  gender?: string;
  tag?: string;
  isDefault?: boolean;
}

export function parseAddresses(data: unknown): AddressCard[] {
  const arr = asArray(data, ['data', 'list', 'addresses', 'items']);
  const out: AddressCard[] = [];
  for (const o of arr) {
    const id = str(o.addressId) ?? str(o.id);
    if (!id) continue;
    const a: AddressCard = { addressId: id };
    const cn = str(o.contactName) ?? str(o.name);
    if (cn) a.contactName = cn;
    const phone = str(o.phone);
    if (phone) a.phone = phone;
    const city = str(o.city);
    if (city) a.city = city;
    const addr = str(o.address);
    if (addr) a.address = addr;
    const detail = str(o.addressDetail);
    if (detail) a.detail = detail;
    const gender = str(o.gender);
    if (gender) a.gender = gender;
    const tag = str(o.tag) ?? str(o.addressTag);
    if (tag) a.tag = tag;
    if (o.isDefault === true || o.isDefault === 1) a.isDefault = true;
    out.push(a);
  }
  return out;
}

/* ============================================================
 * 8. 价格试算
 * ============================================================ */

export interface PriceBreakdown {
  total: number;
  original?: number;
  discount?: number;
  productTotal?: number;
  deliveryFee?: number;
  packingFee?: number;
  tablewareFee?: number;
  items: Array<{ name?: string; code?: string; quantity?: number; subtotal?: number; originalSubtotal?: number }>;
  takeWays: Array<{ code: string; title: string }>;
}

export function parsePrice(data: unknown): PriceBreakdown | undefined {
  const body = unwrap(data);
  if (!isObj(body)) return undefined;
  const cents = num(body.price) ?? num(body.totalPrice) ?? num(body.payAmount);
  if (cents === undefined) return undefined;
  const fromCents = (n: number) => Math.round(n) / 100;

  const out: PriceBreakdown = { total: fromCents(cents), items: [], takeWays: [] };
  const orig = num(body.originalPrice);
  if (orig !== undefined) out.original = fromCents(orig);
  const disc = num(body.discount);
  if (disc !== undefined) out.discount = fromCents(disc);
  const pTotal = num(body.productPrice);
  if (pTotal !== undefined) out.productTotal = fromCents(pTotal);
  const dFee = num(body.deliveryPrice);
  if (dFee !== undefined) out.deliveryFee = fromCents(dFee);
  const pFee = num(body.packingPrice);
  if (pFee !== undefined) out.packingFee = fromCents(pFee);
  const tFee = num(body.tablewarePrice);
  if (tFee !== undefined) out.tablewareFee = fromCents(tFee);

  if (Array.isArray(body.productList)) {
    for (const p of body.productList) {
      if (!isObj(p)) continue;
      const item: { name?: string; code?: string; quantity?: number; subtotal?: number; originalSubtotal?: number } = {};
      const name = str(p.productName);
      if (name) item.name = name;
      const code = str(p.productCode);
      if (code) item.code = code;
      const q = num(p.quantity);
      if (q !== undefined) item.quantity = q;
      const sub = num(p.subtotal);
      if (sub !== undefined) item.subtotal = fromCents(sub);
      const osub = num(p.originalSubtotal);
      if (osub !== undefined) item.originalSubtotal = fromCents(osub);
      out.items.push(item);
    }
  }

  if (Array.isArray(body.takeWayList)) {
    for (const t of body.takeWayList) {
      if (!isObj(t)) continue;
      const code = str(t.code);
      if (!code) continue;
      out.takeWays.push({ code, title: str(t.title) ?? str(t.name) ?? code });
    }
  }

  return out;
}

/* ============================================================
 * 9. 工具台：任意工具直调
 * ============================================================ */

export interface ToolCallResult {
  meta: BlockMeta;
  /** 结构化数据（能解析出 JSON 就有，否则 null） */
  json: unknown;
  /** 服务端原始文本（工具台的主视图 —— 让用户看见 MCP 到底回了什么） */
  text: string;
  /** 文本里识别到的表格（TOON 或 md 表），前端可直接画成表格 */
  table?: { columns: string[]; rows: Array<Record<string, string>> };
}

/**
 * 直调任意工具。
 *
 * 安全：写操作必须显式 `confirm: true`，否则拒绝 —— 这是唯一能阻止
 * "前端误点一下就下单" 的地方（前端也会二次确认，双重保险）。
 */
export async function runTool(
  userId: string,
  tool: string,
  args: Record<string, unknown> = {},
  opts: { confirm?: boolean } = {},
): Promise<ToolCallResult> {
  const cat = TOOL_CATALOG.find((t) => t.name === tool);
  if (!cat) {
    throw new Error(`没有这个工具：${tool}`);
  }
  if (!cat.readonly && opts.confirm !== true) {
    throw new Error(`${cat.title}（${tool}）是写操作，需要显式确认后才能调用`);
  }

  const env = await callToolEnvelope(userId, tool, args, {
    cacheTtl: cat.readonly ? undefined : null,
    timeoutMs: cat.readonly ? 20_000 : 30_000,
  });

  const text = env.rawText ?? '';
  const json = typeof env.data === 'string' ? parseLoose(env.data) : env.data;

  const meta = baseMeta(tool, env);
  const result: ToolCallResult = { meta, json, text };

  const toon = parseToonTable(text);
  if (toon) {
    result.table = { columns: toon.columns, rows: toon.rows };
  } else {
    const md = parseMarkdownTable(text);
    if (md.length) {
      result.table = { columns: Object.keys(md[0]!), rows: md };
    }
  }
  return result;
}

export { TOOL_CATALOG };
