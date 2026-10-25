/**
 * 外送服务（履约方式 = 外送 / 麦乐送 beType=2）
 *
 * 为什么单独一个模块：外送和到店在 MCP 上是**两条不同的链路**，
 * 任何一处混用都会导致「查得到菜单、下不了单」。
 *
 *   ┌──────────┬─────────┬─────────┬──────────────────┬──────────────┐
 *   │ 履约     │ orderType │ beType │ 门店来源          │ beCode        │
 *   ├──────────┼─────────┼─────────┼──────────────────┼──────────────┤
 *   │ 到店自取 │    1    │   1     │ query-nearby-stores │ 不传（传了报错）│
 *   │ 外送     │    2    │   2     │ delivery-query-stores │ 必传        │
 *   └──────────┴─────────┴─────────┴──────────────────┴──────────────┘
 *
 * 另外两处硬差异（都踩过）：
 *   1. 商品编码是两套：同门店 90 个到店商品里 77 个外送不存在
 *      → 外送必须用 orderType=2 重新查菜单，绝不可沿用对话里的到店菜单
 *   2. 外送 calculate-price 没有 takeWayList（不需要 takeWayCode），
 *      但必传 addressId + beCode，且 total 里含配送费与打包费
 */
import { createLogger } from '../lib/logger.js';
import { AuthError, BadRequestError, McpDownError, NotFoundError, RateLimitError } from '../lib/errors.js';
import { callTool } from '../mcp/gateway.js';
import {
  adaptAddresses,
  adaptDeliveryStores,
  adaptPrice,
  type PriceInfo,
  type StoreInfo,
} from './mcp-adapter.js';
import type { DeliveryAddress, Fulfillment, CreateAddressRequest } from '../types/contract.js';

const log = createLogger('delivery');

/** 是否是外送场景 */
export function isDelivery(f: Fulfillment | undefined): boolean {
  return f === '外送';
}

/**
 * 把履约方式翻译成 MCP 入参。
 *
 * 集中在一处，避免 orchestrator / order.service 各写一份容易漂移。
 */
export function fulfillmentArgs(f: Fulfillment | undefined): {
  orderType: 1 | 2;
  beType: 1 | 2;
  delivery: boolean;
} {
  if (f === '外送') return { orderType: 2, beType: 2, delivery: true };
  // 自取 / 堂食 都走到店链路（beType=1 不传 beCode）
  return { orderType: 1, beType: 1, delivery: false };
}

/* ------------------------------------------------------------------ */
/* 地址                                                              */
/* ------------------------------------------------------------------ */

/** 查用户已存的外送地址（失败返回空数组，不阻塞对话） */
export async function listAddresses(userId: string): Promise<DeliveryAddress[]> {
  try {
    const raw = await callTool(userId, 'delivery-query-addresses', {});
    return adaptAddresses(raw);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    log.warn(`查地址失败：${(err as Error).message}`);
    return [];
  }
}

/**
 * 按 addressId 取地址；传空则取默认地址，没有默认就取第一条。
 *
 * 返回 null 表示用户一个地址都没有 —— 调用方要引导去新建，
 * 不能拿一个假地址硬往下走。
 */
export async function pickAddress(
  userId: string,
  addressId?: string,
): Promise<DeliveryAddress | null> {
  const all = await listAddresses(userId);
  if (all.length === 0) return null;

  if (addressId) {
    const hit = all.find((a) => a.addressId === addressId);
    if (!hit) {
      // 传了 id 但不在列表里 → 说明地址被删了，明确报错而不是偷偷换一个
      throw new BadRequestError('这个配送地址找不到了，重新选一个');
    }
    return hit;
  }

  return all.find((a) => a.isDefault) ?? all[0]!;
}

/** 新建地址。MCP 写操作，不缓存 */
export async function createAddress(
  userId: string,
  input: CreateAddressRequest,
): Promise<DeliveryAddress> {
  const phone = (input.phone ?? '').trim();
  if (!/^1\d{10}$/.test(phone)) throw new BadRequestError('手机号要 11 位纯数字，且以 1 开头');

  const payload = {
    city: input.city.trim(),
    contactName: input.contactName.trim(),
    phone,
    address: input.address.trim(),
    addressDetail: input.addressDetail.trim(),
    ...(input.gender ? { gender: input.gender } : {}),
  };

  if (!payload.city || !payload.contactName || !payload.address || !payload.addressDetail) {
    throw new BadRequestError('城市、联系人、地址、门牌号都要填');
  }

  const raw = await callTool(userId, 'delivery-create-address', payload, {
    cacheTtl: null,
    timeoutMs: 20_000,
  });

  /**
   * 创建接口有的版本只回 success，不回 addressId。
   * 所以这里不强依赖返回值：拿不到就重新拉一次列表，按手机号+门牌匹配。
   */
  const created = adaptAddresses(raw).find((a) => a.addressId);
  if (created) return created;

  const all = await listAddresses(userId);
  const matched =
    all.find((a) => a.phone === phone && a.fullAddress.includes(payload.addressDetail)) ??
    all.find((a) => a.fullAddress.includes(payload.addressDetail));
  if (matched) return matched;

  throw new McpDownError('地址建好了但没查到，刷新一下地址列表试试');
}

/* ------------------------------------------------------------------ */
/* 外送门店                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按地址查可配送门店。
 *
 * 外送的门店列表和到店不是一回事：外送只返回「这个地址能送到的店」，
 * 所以必须先用地址换门店，不能拿 near 门店直接下外送单。
 */
export async function queryDeliveryStores(
  userId: string,
  addressId: string,
  beType: 2 | 6 = 2,
): Promise<StoreInfo[]> {
  try {
    const raw = await callTool(userId, 'delivery-query-stores', { addressId, beType });
    const stores = adaptDeliveryStores(raw).filter((s) => s.storeCode);
    return stores;
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    log.warn(`外送门店查询失败：${(err as Error).message}`);
    return [];
  }
}

/**
 * 选一个可配送门店。
 *
 * 优先沿用记忆里的常去门店（如果它也在可配送范围），
 * 否则取列表第一家 —— 由 MCP 的返回顺序决定，通常是最优配送门店。
 */
export async function resolveDeliveryStore(
  userId: string,
  addressId: string,
  preferredName?: string,
): Promise<StoreInfo> {
  const stores = await queryDeliveryStores(userId, addressId);
  if (stores.length === 0) {
    throw new McpDownError('这个地址暂时没有可配送的麦当劳门店，换个地址试试');
  }

  if (preferredName) {
    const hit = stores.find(
      (s) => s.name === preferredName || s.name.includes(preferredName) || preferredName.includes(s.name),
    );
    if (hit) return hit;
  }

  const first = stores[0];
  if (!first) throw new NotFoundError('没找到可配送门店');
  return first;
}

/* ------------------------------------------------------------------ */
/* 外送算价                                                          */
/* ------------------------------------------------------------------ */

/**
 * 外送算价（含配送费与打包费）。
 *
 * 和到店算价的关键区别：
 *   · 必传 addressId + beCode
 *   · 不传 case 也**不需要** takeWayCode（外送没有 takeWayList）
 *   · 返回的 total 已包含 deliveryPrice + packingPrice
 */
export async function calcDeliveryPrice(
  userId: string,
  input: {
    storeCode: string;
    beCode: string;
    addressId: string;
    items: Array<{ productCode: string; quantity: number }>;
  },
): Promise<PriceInfo | null> {
  try {
    const raw = await callTool(
      userId,
      'calculate-price',
      {
        storeCode: input.storeCode,
        orderType: 2,
        beType: 2,
        beCode: input.beCode,
        addressId: input.addressId,
        items: input.items,
      },
      { cacheTtl: null, timeoutMs: 20_000 },
    );
    return adaptPrice(raw);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    log.warn(`外送算价失败：${(err as Error).message}`);
    return null;
  }
}
