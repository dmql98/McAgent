/**
 * MCP 数据适配层
 *
 * 职责：把麦当劳 MCP 的真实返回，转成内部稳定的 RawProduct / StoreInfo。
 *
 * ⚠️ 以下结构全部来自 2026-10 的真实联调（token 实测 35 个工具），不是猜的：
 *
 * query-nearby-stores → { success, data: [ { storeCode, storeName, address,
 *                          distance, businessStatus, reservation, ... } ] }
 *   · storeCode 是唯一编号，后续所有工具的入参
 *   · beType=1(到店自取) 时没有 beCode；beType=5(得来速) 才有，且必须传
 *
 * query-meals → { success, data: { categories, meals, frequent } }
 *   · data.meals 是「以 productCode 为键的对象」，不是数组：
 *     { "1100": { name:"巨无霸", image, currentPrice:"26.5",
 *                 originalPrice:"26.5", canWithOrder:false }, ... }
 *   · 价格是**字符串**，不是数字
 *   · canWithOrder=false 表示当前不可售
 *   · data.categories 才是分类，元素形如 { name:"人气热卖", meals:[{code,tags}] }
 */
import { pickArray, pickNumber, pickString, objectMapToArray } from '../mcp/toon.js';
import type { RawProduct } from './selector.service.js';
import type { DeliveryAddress } from '../types/contract.js';

export interface StoreInfo {
  /** 门店编码，所有后续 MCP 调用的必填入参 */
  storeCode: string;
  name: string;
  address?: string;
  distance?: number;
  open?: boolean;
  /** 得来速(beType=5)场景才有，且后续必须传 */
  beCode?: string;
  reservation?: boolean;
}

/* ------------------------------------------------------------------ */
/* 门店                                                              */
/* ------------------------------------------------------------------ */

const STORE_NAME_KEYS = ['storeName', 'name', 'store_name', 'shopName'];
const STORE_ADDR_KEYS = ['address', 'addr', 'storeAddress'];
const STORE_CODE_KEYS = ['storeCode', 'storeId', 'store_id', 'code', 'id'];

export function adaptStores(data: unknown): StoreInfo[] {
  // 真实返回：data 本身就是数组；兜底再找一层
  let arr: unknown[] = [];
  if (Array.isArray(data)) {
    arr = data;
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.data)) arr = o.data;
    else arr = pickArray(data, ['stores', 'storeList', 'list', 'items']);
  }

  const out: StoreInfo[] = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const code = pickString(o, STORE_CODE_KEYS);
    const name = pickString(o, STORE_NAME_KEYS);
    if (!code || !name) continue;

    const s: StoreInfo = { storeCode: code, name };
    const addr = pickString(o, STORE_ADDR_KEYS);
    if (addr) s.address = addr;
    const dist = pickNumber(o, ['distance', 'dist']);
    if (dist !== undefined) s.distance = dist;
    const open = o.businessStatus ?? o.open ?? o.isOpen;
    if (typeof open === 'boolean') s.open = open;
    if (typeof o.reservation === 'boolean') s.reservation = o.reservation;
    const beCode = pickString(o, ['beCode', 'be_code']);
    if (beCode) s.beCode = beCode;

    out.push(s);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 商品                                                              */
/* ------------------------------------------------------------------ */

const PRODUCT_NAME_KEYS = ['name', 'productName', 'mealName', 'title'];
/** 真实字段顺序：currentPrice 是现价，originalPrice 是原价 */
const PRICE_KEYS = ['currentPrice', 'salePrice', 'price', 'amount', 'unitPrice'];
const ORIGINAL_PRICE_KEYS = ['originalPrice', 'listPrice', 'originPrice', 'marketPrice'];

export function adaptProducts(data: unknown): RawProduct[] {
  if (!data || typeof data !== 'object') return [];

  const root = data as Record<string, unknown>;
  // 真实返回被包了一层 data
  const body = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;

  let list: Array<Record<string, unknown>> = [];

  // 真实形状：body.meals 是以 productCode 为键的对象
  const meals = body.meals;
  if (meals && typeof meals === 'object' && !Array.isArray(meals)) {
    list = objectMapToArray(meals);
  } else if (Array.isArray(meals)) {
    list = meals as Array<Record<string, unknown>>;
  }

  // 兜底：其它可能的数组字段
  if (list.length === 0) {
    const arr = pickArray(body, ['products', 'mealList', 'items', 'list', 'goods']);
    list = arr.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
  }

  // 分类信息：{ name, meals: [{code, tags}] } → code → 分类名
  const catOf = buildCategoryIndex(body.categories);

  const out: RawProduct[] = [];
  for (const raw of list) {
    const p = adaptProduct(raw, catOf);
    if (p) out.push(p);
  }

  return out;
}

/** 把 categories 展平成 productCode → 分类名 */
function buildCategoryIndex(categories: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(categories)) return map;

  for (const cat of categories) {
    if (!cat || typeof cat !== 'object') continue;
    const c = cat as Record<string, unknown>;
    const catName = pickString(c, ['name', 'categoryName']);
    if (!catName) continue;
    const items = c.meals ?? c.items ?? c.products;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const code = pickString(it as Record<string, unknown>, ['code', 'productCode']);
      if (code) map.set(code, catName);
    }
  }
  return map;
}

export function adaptProduct(
  raw: unknown,
  catOf?: Map<string, string>,
): RawProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const name = pickString(o, PRODUCT_NAME_KEYS);
  if (!name) return null;

  const price = pickNumber(o, PRICE_KEYS);
  // 没价格没法算价/下单，直接丢（真实菜单里确实有少量无价商品）
  if (price === undefined || price <= 0) return null;

  const p: RawProduct = { name, price };

  const id = pickString(o, ['productCode', 'productId', 'code', 'id', 'skuId', 'mealId']);
  if (id) p.productId = id;

  const cat = (id && catOf?.get(id)) || pickString(o, ['categoryName', 'category']);
  if (cat) p.category = cat;

  const originalPrice = pickNumber(o, ORIGINAL_PRICE_KEYS);
  if (originalPrice !== undefined && originalPrice > price) p.originalPrice = originalPrice;

  const desc = pickString(o, ['description', 'desc', 'summary', 'introduction']);
  if (desc) p.description = desc;

  /**
   * ⚠️ canWithOrder 不是「可售」，是「随单购」（加购优惠项）。
   *
   * 实测（query-meals 真实返回，90 件商品）：
   *   · canWithOrder=true  → 只有 12 件，且**全部**带 withOrder + discountType「随单购麦金卡优惠」
   *   · canWithOrder=false → 78 件正常单品（板烧鸡腿堡、麦辣鸡翅、薯条、可乐…）
   *
   * 早期版本把它当成可售状态使用，导致 78 件正常单品被全部过滤，
   * 候选池只剩 12 件加购套餐，于是「说什么都只推同样那几份四件套」。
   *
   * 正确做法：
   *   · 加购项 → 记为随单购标记，不参与默认选品（需搭配主商品才能下单）
   *   · 真正的可售状态只看 available / isAvailable / saleStatus / status
   *   · 没有可售字段 → 视为可售（宁可多给候选，也不要误杀真实商品）
   */
  if (o.withOrder || typeof o.canWithOrder === 'boolean') {
    p.withOrderOnly = o.canWithOrder !== false;
  }

  const avail = o.available ?? o.isAvailable ?? o.saleStatus ?? o.status;
  if (typeof avail === 'boolean') p.available = avail;
  else if (typeof avail === 'string') p.available = !/unavailable|soldout|off/i.test(avail);

  // 特制项 / 套餐组成 / 配料（真实返回里通常没有，保留兼容）
  attachList(p, 'modifications', o.modifications ?? o.options ?? o.specifications);
  attachList(p, 'combo', o.combo ?? o.comboItems ?? o.subItems);
  attachList(p, 'ingredients', o.ingredients ?? o.materials);

  return p;
}

function attachList(
  p: RawProduct,
  field: 'modifications' | 'combo' | 'ingredients',
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const list = value
    .map((x) =>
      typeof x === 'string' ? x : pickString(x, ['name', 'optionName', 'value', 'productName', 'materialName']),
    )
    .filter((x): x is string => Boolean(x));
  if (list.length > 0) p[field] = list;
}

/* ------------------------------------------------------------------ */
/* 价格                                                              */
/* ------------------------------------------------------------------ */

export interface PriceInfo {
  /** 单位：元（已从分转换） */
  total: number;
  original?: number;
  discount?: number;
  /** create-order 必填的 takeWayCode 候选（来自 takeWayList） */
  takeWay?: { code: string; title: string };
  /**
   * 外送专属：配送费 + 打包服务费（单位元）。
   * 到店场景这两个字段不存在；外送的 total **已包含**这两项，
   * 所以外送菜单的「券后实付」必须直接取 calculate-price 的 price，
   * 不能用商品单价相加（那样会少算配送费）。
   */
  deliveryFee?: number;
  packingFee?: number;
  /** 起送门槛（分→元），拿不到就不填 */
  minOrder?: number;
}

/**
 * 真实返回（实测 calculate-price）：
 * {
 *   "productOriginalPrice": 2650,
 *   "productPrice": 2650,
 *   "originalPrice": 2650,
 *   "discount": 0,
 *   "price": 2650,
 *   "productList": [...],
 *   "takeWayList": [ { code:"eat-in", title:"堂食" }, { code:"take-in-store", ... } ]
 * }
 *
 * ⚠️ 所有金额单位都是「分」，必须除以 100。
 * （26.5 元的巨无霸 → 2650，这一点极容易搞错，会把 ¥26.5 算成 ¥2650）
 */
export function adaptPrice(data: unknown): PriceInfo | null {
  if (data === null || data === undefined) return null;

  // 真实返回被包在 { success, code, data } 里，先剥一层
  let body: unknown = data;
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    const inner = (body as Record<string, unknown>).data;
    if (inner && typeof inner === 'object') body = inner;
  }

  if (typeof body === 'number') return { total: fromCents(body) };

  const cents =
    pickNumber(body, ['price', 'productPrice', 'totalPrice', 'payAmount', 'finalPrice', 'amount']) ??
    undefined;
  if (cents === undefined) return null;

  const info: PriceInfo = { total: fromCents(cents) };

  const orig = pickNumber(body, ['originalPrice', 'productOriginalPrice', 'listPrice']);
  if (orig !== undefined) info.original = fromCents(orig);

  const disc = pickNumber(body, ['discount', 'discountAmount', 'savedAmount']);
  if (disc !== undefined && disc > 0) info.discount = fromCents(disc);

  // 取第一个可用的取餐方式作为默认
  const tw = (body as Record<string, unknown> | null)?.takeWayList;
  if (Array.isArray(tw) && tw.length > 0) {
    const first = tw[0] as Record<string, unknown>;
    const code = pickString(first, ['code']);
    const title = pickString(first, ['title', 'name']);
    if (code) info.takeWay = { code, title: title ?? code };
  }

  /**
   * 外送费用（到店场景不会有这两项）。
   * 真实字段：deliveryPrice / packingPrice，单位同样是分。
   */
  const dfee = pickNumber(body, ['deliveryPrice', 'deliveryFee', 'shippingFee']);
  if (dfee !== undefined && dfee > 0) info.deliveryFee = fromCents(dfee);

  const pfee = pickNumber(body, ['packingPrice', 'packingFee', 'packagePrice']);
  if (pfee !== undefined && pfee > 0) info.packingFee = fromCents(pfee);

  const minOrder = pickNumber(body, ['minOrderPrice', 'minDeliveryPrice', 'startDeliveryPrice']);
  if (minOrder !== undefined && minOrder > 0) info.minOrder = fromCents(minOrder);

  return info;
}

/** 分 → 元，保留两位 */
function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/* ------------------------------------------------------------------ */
/* 营养                                                              */
/* ------------------------------------------------------------------ */

/** 从营养数据里抓总热量，返回 "≈ 720 kcal" 这种一句话 */
export function adaptNutrition(data: unknown): string | undefined {
  const arr = pickArray(data, ['foods', 'nutrition', 'items', 'list', 'data']);
  if (arr.length === 0) {
    const n = pickNumber(data, ['calories', 'kcal', 'energy', 'calorie']);
    return n !== undefined ? `≈ ${Math.round(n)} kcal` : undefined;
  }

  let sum = 0;
  let found = false;
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const n = pickNumber(raw, ['calories', 'kcal', 'energy', 'calorie', 'heat']);
    if (n !== undefined) {
      sum += n;
      found = true;
    }
  }
  if (!found) return undefined;
  return `≈ ${Math.round(sum)} kcal`;
}

/* ------------------------------------------------------------------ */
/* 优惠券                                                            */
/* ------------------------------------------------------------------ */

export interface CouponInfo {
  id: string;
  name: string;
  amount?: number;
  threshold?: number;
}

export function adaptCoupons(data: unknown): CouponInfo[] {
  const arr = pickArray(data, ['coupons', 'couponList', 'list', 'items', 'data']);
  const out: CouponInfo[] = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = pickString(o, ['couponId', 'id', 'code']);
    const name = pickString(o, ['couponName', 'name', 'title']);
    if (!id || !name) continue;
    const c: CouponInfo = { id, name };
    const amt = pickNumber(o, ['amount', 'discountAmount', 'value', 'faceValue']);
    if (amt !== undefined) c.amount = amt;
    const th = pickNumber(o, ['threshold', 'minAmount', 'condition']);
    if (th !== undefined) c.threshold = th;
    out.push(c);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 外送地址                                                          */
/* ------------------------------------------------------------------ */

/**
 * delivery-query-addresses 真实返回：
 * { success, data: [ { addressId, contactName, phone:"181****3971",
 *   city, address:"清竹园9号楼", addressDetail:"2单元508",
 *   gender:"先生", tag:"家", isDefault:true } ] }
 *
 * 注意：phone 返回的就是**已脱敏**的，不要再自己打码。
 */
export function adaptAddresses(data: unknown): DeliveryAddress[] {
  let arr: unknown[] = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.data)) arr = o.data;
    else arr = pickArray(data, ['addresses', 'list', 'items']);
  }

  const out: DeliveryAddress[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const addressId = pickString(o, ['addressId', 'id', 'addrId']);
    if (!addressId) continue;

    const addr = pickString(o, ['address', 'fullAddress', 'addr']) ?? '';
    const detail = pickString(o, ['addressDetail', 'detail', 'doorNo']) ?? '';
    const fullAddress = [addr, detail].filter(Boolean).join(' ').trim() || addr;

    const a: DeliveryAddress = {
      addressId,
      contactName: pickString(o, ['contactName', 'name', 'receiver']) ?? '',
      phone: pickString(o, ['phone', 'mobile', 'telephone']) ?? '',
      fullAddress,
    };
    const tag = pickString(o, ['tag', 'addressTag']);
    if (tag) a.tag = tag;
    const gender = pickString(o, ['gender']);
    if (gender) a.gender = gender;
    if (o.isDefault === true || o.isDefault === 1) a.isDefault = true;

    out.push(a);
  }
  return out;
}

/** 外送可配送门店：返回结构与 query-nearby-stores 基本一致，只是附带 beCode */
export function adaptDeliveryStores(data: unknown): StoreInfo[] {
  // 结构同 adaptStores，外送返回里 beCode 是必有的 —— 复用即可
  return adaptStores(data);
}

/* ------------------------------------------------------------------ */
/* 订单                                                              */
/* ------------------------------------------------------------------ */

export interface OrderRaw {
  orderId: string;
  payUrl: string;
  status: string;
  total?: number;
  /**
   * 门店名。MCP 建单响应里带着 `orderDetail.storeName`，
   * 这是**唯一权威**的门店名来源 —— 我们这边只能拿到 storeCode，
   * 名字要么靠猜、要么靠重搜，都不如它准。
   */
  storeName?: string;
}

/**
 * create-order 的返回。
 *
 * ⚠️ 这里必须解 `data` 包装层。MCP 把真正的订单放在 `{success, code, message, data:{...}}` 里，
 * 而 `orderId` 在 `data` 下、不在顶层。
 *
 * 漏解包的后果比"解析失败"严重得多：订单在麦当劳那边**已经建成功了**，
 * 但我们把响应判成看不懂 → 抛错 → 用户以为没下成、又点一次 → 重复下单两次。
 * 所以这里找不到就直接返回 null，绝不能编一个假 orderId 往下走。
 */
export function adaptOrder(data: unknown): OrderRaw | null {
  if (!data || typeof data !== 'object') return null;

  const root = data as Record<string, unknown>;
  const o = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;

  /**
   * 显式失败声明直接判负，**不要再看有没有 id**。
   *
   * 失败响应里可能带着 `id`/`traceId` 这类字段，而下面 `orderId` 的候选里有 `id`。
   * 若不先拦住，一次「今日下单数已经上限」会被解析成一个假订单，
   * 用户拿到一个无效 orderId 去付款，比直接报错糟得多。
   */
  const ok = root.success ?? root['ok'] ?? o.success;
  if (ok === false) return null;

  /**
   * 订单号可能藏在 `data.orderDetail` 里（`data.orderId` 通常也有，但别赌）。
   * 逐层收敛，优先取最外层。
   */
  const detail = (o.orderDetail && typeof o.orderDetail === 'object'
    ? o.orderDetail
    : {}) as Record<string, unknown>;

  const orderId =
    pickString(o, ['orderId', 'orderNo', 'orderCode']) ?? pickString(detail, ['orderId', 'orderNo', 'orderCode']);

  // 拿不到订单号 = 拿不到这次下单的凭据，必须让调用方按失败处理
  if (!orderId) return null;

  /** 支付链接：外送/到店都见过 `payH5Url`，也有 `payUrl` 的写法，都认 */
  const payUrl =
    pickString(o, ['payH5Url', 'payUrl', 'payURL', 'paymentUrl', 'payLink', 'h5Url', 'url']) ??
    pickString(detail, ['payH5Url', 'payUrl', 'payURL']) ??
    '';

  /** 状态：顶层 status 常是数字码（"10"），detail.orderStatus 才是「待支付」这种可读值 */
  const status =
    pickString(detail, ['orderStatus', 'statusName']) ??
    pickString(o, ['orderStatus', 'statusName', 'status', 'state']) ??
    'created';

  const total =
    pickNumber(o, ['total', 'totalPrice', 'payAmount', 'actualAmount', 'amount']) ??
    pickNumber(detail, ['total', 'totalPrice', 'payAmount', 'actualAmount', 'amount']);

  /** 门店名：建单响应里最权威的一份，调用方拿它去补订单上的店名 */
  const storeName =
    pickString(detail, ['storeName', 'shopName', 'storeTitle']) ??
    pickString(o, ['storeName', 'shopName', 'storeTitle']);

  const out: OrderRaw = { orderId, payUrl, status };
  if (total !== undefined) out.total = total;
  if (storeName) out.storeName = storeName;
  return out;
}

/* ------------------------------------------------------------------ */
/* 时间                                                              */
/* ------------------------------------------------------------------ */

export function adaptNowTime(data: unknown): { currentSlot?: string; timestamp?: number } {
  if (!data || typeof data !== 'object') return {};
  const o = data as Record<string, unknown>;
  const out: { currentSlot?: string; timestamp?: number } = {};
  const slot = pickString(o, ['mealPeriod', 'currentMealPeriod', 'period', 'timeSlot']);
  if (slot) out.currentSlot = slot;
  const ts = pickNumber(o, ['timestamp', 'now', 'serverTime']);
  if (ts !== undefined) out.timestamp = ts;
  return out;
}
