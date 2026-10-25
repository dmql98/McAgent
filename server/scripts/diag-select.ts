/**
 * 选品诊断：把候选池、打分、装箱过程全打出来
 *
 * 用法：node --import tsx scripts/diag-select.ts <token> <people> [fulfillment]
 */
import { login } from '../src/services/auth.service.js';
import { callTool } from '../src/mcp/gateway.js';
import { adaptProducts, adaptStores, adaptAddresses } from '../src/services/mcp-adapter.js';
import { parseIntent } from '../src/services/intent.service.js';
import { composeStrategy } from '../src/services/knowledge.service.js';
import { selectProducts, buildMenuItems, qtyOf } from '../src/services/selector.service.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const [TOKEN = '', peopleArg = '1', fulf = '外送', msg = '今天有点烦躁欸'] = process.argv.slice(2);
const people = Number(peopleArg);

async function main() {
  loadConfig();
  getDb();
  const { userId } = await login(TOKEN);

  // 取外送或到店菜单
  let storeCode = '';
  let beCode = '';
  let products;

  if (fulf === '外送') {
    const addrs = adaptAddresses(await callTool(userId, 'delivery-query-addresses', {}));
    const addr = addrs.find((a) => a.isDefault) ?? addrs[0]!;
    const stores = adaptStores(await callTool(userId, 'delivery-query-stores', { addressId: addr.addressId, beType: 2 }));
    storeCode = stores[0]!.storeCode;
    beCode = stores[0]!.beCode!;
    products = adaptProducts(
      await callTool(userId, 'query-meals', { storeCode, orderType: 2, beType: 2, beCode }),
    );
  } else {
    const stores = adaptStores(
      await callTool(userId, 'query-nearby-stores', { beType: 1, searchType: 2, city: '厦门市', keyword: '麦当劳' }),
    );
    storeCode = stores[0]!.storeCode;
    products = adaptProducts(await callTool(userId, 'query-meals', { storeCode, orderType: 1, beType: 1 }));
  }

  const intent = parseIntent(msg, new Date());
  intent.explicit.people = people;

  const strategy = composeStrategy({
    now: new Date(),
    mood: intent.mood,
    taboo: intent.explicit.taboo,
  });

  const sel = selectProducts({
    products,
    strategy: strategy.solarTerm,
    moodStrategy: strategy.moodStrategy,
    snapshot: null,
    intent,
    people,
  });

  const menu = buildMenuItems({ picked: sel.items, details: sel.details, people, snapshot: null });

  console.log(`\n=== 意图 · ${people} 人 · ${fulf} ===`);
  console.log(`原文：${msg}`);
  console.log(`情绪：${intent.mood} · 口味：[${intent.explicit.taste.join(',')}] · 预算：${intent.explicit.budget ?? '无'}`);

  console.log(`\n--- 候选池 ${products.length} 件，Top 25 得分 ---`);
  for (const d of sel.details.slice(0, 25)) {
    const p = d.product;
    const role = /甜|冰淇淋|新地|圆筒|派/.test(`${p.category ?? ''} ${p.name ?? ''}`)
      ? 'D'
      : /饮|可乐|咖啡|茶|水|奶/.test(`${p.category ?? ''} ${p.name ?? ''}`)
        ? 'R'
        : /堡|主食|套餐|饭/.test(`${p.category ?? ''} ${p.name ?? ''}`)
          ? 'M'
          : 'o';
    console.log(
      `  [${role}] ${String(d.score).padStart(3)}  ¥${String(p.price).padStart(6)} ×${qtyOf(p, people)}  ${p.name}` +
        `  ${d.reasons.slice(0, 2).join(' / ')}`,
    );
  }

  console.log(`\n--- 最终菜单 ${menu.length} 项 ---`);
  let total = 0;
  let mains = 0;
  for (const m of menu) {
    total += m.price;
    if (/堡|套餐|饭/.test(m.name)) mains++;
    console.log(`  ${m.name} ${m.spec}  ¥${m.price}  — ${m.why}`);
  }
  console.log(`\n  商品合计 ¥${total.toFixed(2)} · 主食项 ${mains} · 人数 ${people}`);
  if (mains > people * 1.5) console.log(`  ⚠️ 主食过量：${mains} 项主食给 ${people} 人`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
