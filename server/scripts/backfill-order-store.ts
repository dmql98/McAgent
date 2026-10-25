/**
 * 一次性回填历史订单的门店名。
 *
 * 背景：`store` 字段在修复前一直是空串 —— 购物车下单时 `meta.store` 为空，
 * 而 `orderDetail.storeName` 压根没被解析出来。已经落库的订单不该带着空门店留着，
 * 用户查历史订单会以为是数据丢了。
 *
 * 做法：拿订单关联的 chat 里的 `store_code`，调一次 query-nearby-stores 反查名字。
 * 查不到就跳过 —— **绝不猜**，宁可留空也不写错门店。
 *
 * 用法：npx tsx scripts/backfill-order-store.ts <userId> [--dry-run]
 */
import { getDb } from '../src/db/index.js';
import { callTool } from '../src/mcp/gateway.js';
import { adaptDeliveryStores, adaptStores } from '../src/services/mcp-adapter.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('backfill');

interface Row {
  id: string;
  store: string;
  store_code: string | null;
  be_code: string | null;
  fulfillment: string | null;
  address_id: string | null;
}

async function main(): Promise<void> {
  const userId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!userId) {
    console.error('用法：npx tsx scripts/backfill-order-store.ts <userId> [--dry-run]');
    process.exit(1);
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.id, o.store, c.store_code, c.be_code, o.fulfillment, o.address_id
       FROM orders o LEFT JOIN chats c ON o.chat_id = c.id
       WHERE o.user_id = ? AND (o.store IS NULL OR o.store = '')`,
    )
    .all<Row>(userId);

  if (rows.length === 0) {
    console.log('没有需要回填的订单');
    return;
  }
  console.log(`待回填 ${rows.length} 条${dryRun ? '（dry-run，不写库）' : ''}`);

  /**
   * 到店和外送是**两套门店列表**：
   *   · 到店 → query-nearby-stores（按城市/关键字）
   *   · 外送 → delivery-query-stores（按地址，且必须有 addressId）
   * 用错接口必然查不到，早先只用前者，外送单全部被跳过。
   */
  const codeToName = new Map<string, string>();
  const loadNearby = async (city: string): Promise<void> => {
    try {
      const raw = await callTool(userId, 'query-nearby-stores', {
        beType: 1,
        searchType: 2,
        city,
        keyword: '麦当劳',
      });
      for (const s of adaptStores(raw)) {
        if (s.storeCode && s.name) codeToName.set(s.storeCode, s.name);
      }
    } catch (err) {
      log.warn(`拉「${city}」门店失败：${(err as Error).message}`);
    }
  };

  await loadNearby(process.env.MCD_DEFAULT_CITY || '厦门市');

  // 外送单按订单里的地址单独查
  const addressIds = [...new Set(rows.map((r) => r.address_id).filter((x): x is string => Boolean(x)))];
  for (const aid of addressIds) {
    try {
      const raw = await callTool(userId, 'delivery-query-stores', { addressId: aid, beType: 2 });
      for (const s of adaptDeliveryStores(raw)) {
        if (s.storeCode && s.name) codeToName.set(s.storeCode, s.name);
      }
    } catch (err) {
      log.warn(`拉地址 ${aid} 的外送门店失败：${(err as Error).message}`);
    }
  }
  console.log(`候选门店 ${codeToName.size} 家`);

  let filled = 0;
  let skipped = 0;
  for (const r of rows) {
    const known = r.store_code ? codeToName.get(r.store_code) : undefined;
    if (!known) {
      console.log(
        `  跳过 ${r.id.slice(-6)}：${r.store_code ? `门店 ${r.store_code} 不在候选列表里` : '订单没有 store_code，无从反查'}`,
      );
      skipped++;
      continue;
    }
    console.log(`  ${r.id.slice(-6)} → ${known}`);
    if (!dryRun) {
      db.prepare('UPDATE orders SET store = ?, updated_at = ? WHERE id = ?').run(known, Date.now(), r.id);
    }
    filled++;
  }

  log.info(`回填完成 filled=${filled} skipped=${skipped} dryRun=${dryRun}`);
  console.log(`\n完成：补上 ${filled} 条，跳过 ${skipped} 条`);
}

void main();
