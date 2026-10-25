/**
 * 门店解析：记忆里的「城市 + 关键词」→ 真实门店
 *
 * 为什么单独一层：
 * 菜单页、优惠券页、对话流水线三处都要拿门店，且逻辑必须一致
 * （同一家店，价格才不会对不上）。所以统一在这里做，别各写一遍。
 *
 * 约束（实测）：query-nearby-stores **不认经纬度**，只吃 city + keyword。
 * 坐标在 POST /api/location 时已经反查成 city/district 存进记忆了。
 */
import { createLogger } from '../lib/logger.js';
import { McpDownError, NeedLocationError } from '../lib/errors.js';
import { callTool } from '../mcp/gateway.js';
import { adaptStores, type StoreInfo } from './mcp-adapter.js';
import { getMemoryService } from './memory.service.js';

const log = createLogger('store');

export interface ResolvedStore {
  store: StoreInfo;
  city: string;
  /** 本次搜索用的关键词，方便前端展示"按这里找的店" */
  keyword: string;
}

/**
 * 拿用户当前门店。拿不到就抛：
 *   · 没有城市   → NeedLocationError（前端引导授权定位）
 *   · 有城市无店 → McpDownError（前端提示换关键词/稍后）
 */
export async function resolveStore(userId: string): Promise<ResolvedStore> {
  const snap = getMemoryService().snapshot(userId);
  const city = snap.usualCity ?? '';
  const keyword = snap.usualKeyword ?? snap.usualStore ?? '';

  if (!city) {
    throw new NeedLocationError('先允许定位，我才能查到你附近的门店');
  }

  const queries: Array<Record<string, unknown>> = [];
  if (keyword) queries.push({ beType: 1, searchType: 2, city, keyword });
  if (keyword !== '麦当劳') queries.push({ beType: 1, searchType: 2, city, keyword: '麦当劳' });

  for (const q of queries) {
    try {
      const got = adaptStores(await callTool(userId, 'query-nearby-stores', q));
      if (got.length === 0) continue;

      // 优先记忆里的常去门店（名字互相包含即视为同一家）
      let picked = got[0]!;
      if (snap.usualStore) {
        const matched = got.find(
          (s) => s.name.includes(snap.usualStore!) || snap.usualStore!.includes(s.name),
        );
        if (matched) picked = matched;
      }
      return { store: picked, city, keyword: String(q.keyword ?? '') };
    } catch (err) {
      // 鉴权/限流必须冒泡，不能当成"搜不到店"
      if ((err as { code?: string })?.code === 'TOKEN_INVALID') throw err;
      if ((err as { code?: string })?.code === 'RATE_LIMITED') throw err;
      log.warn(`门店查询失败（${JSON.stringify(q)}）：${(err as Error).message}`);
    }
  }

  throw new McpDownError(`没在「${city}」搜到可点餐门店，换个关键词试试`);
}
