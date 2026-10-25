/**
 * 菜单商品普查：按品类看有哪些「套餐 / 多人餐 / 单点」
 * node --import tsx scripts/diag-menu.ts <token> [外送|自取]
 */
import { login } from '../src/services/auth.service.js';
import { callTool } from '../src/mcp/gateway.js';
import { adaptProducts, adaptStores, adaptAddresses } from '../src/services/mcp-adapter.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const [TOKEN = '', fulf = '外送'] = process.argv.slice(2);

async function main() {
  loadConfig();
  getDb();
  const { userId } = await login(TOKEN);

  let products;
  if (fulf === '外送') {
    const addrs = adaptAddresses(await callTool(userId, 'delivery-query-addresses', {}));
    const addr = addrs.find((a) => a.isDefault) ?? addrs[0]!;
    const stores = adaptStores(await callTool(userId, 'delivery-query-stores', { addressId: addr.addressId, beType: 2 }));
    products = adaptProducts(
      await callTool(userId, 'query-meals', {
        storeCode: stores[0]!.storeCode,
        orderType: 2,
        beType: 2,
        beCode: stores[0]!.beCode,
      }),
    );
  } else {
    const stores = adaptStores(
      await callTool(userId, 'query-nearby-stores', { beType: 1, searchType: 2, city: '厦门市', keyword: '麦当劳' }),
    );
    products = adaptProducts(await callTool(userId, 'query-meals', { storeCode: stores[0]!.storeCode, orderType: 1, beType: 1 }));
  }

  const groups: Record<string, typeof products> = {
    '多人/双人': [],
    '单人餐/四件套': [],
    套餐: [],
    汉堡: [],
    小食: [],
    饮品: [],
    甜品: [],
    其他: [],
  };

  for (const p of products) {
    const n = p.name;
    if (/双人|多人|分享|全家|2人|两人/.test(n)) groups['多人/双人']!.push(p);
    else if (/单人|四件套|三件套|随心选|随心配/.test(n)) groups['单人餐/四件套']!.push(p);
    else if (/套餐|组合/.test(n)) groups['套餐']!.push(p);
    else if (/堡|主食|饭/.test(n)) groups['汉堡']!.push(p);
    else if (/甜|冰淇淋|新地|圆筒|派|蛋糕/.test(n)) groups['甜品']!.push(p);
    else if (/饮|可乐|咖啡|茶|奶|水/.test(n)) groups['饮品']!.push(p);
    else if (/薯条|鸡块|鸡翅|鸡排|玉米|沙拉|苹果|小食|麦乐/.test(n)) groups['小食']!.push(p);
    else groups['其他']!.push(p);
  }

  console.log(`\n=== ${fulf} 菜单 ${products.length} 件 ===`);
  for (const [k, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    console.log(`\n【${k}】${list.length} 件`);
    for (const p of list.slice(0, 40)) {
      const flags = p.withOrderOnly ? ' [随单购]' : '';
      console.log(`  ¥${String(p.price).padStart(6)}  ${p.name}${flags}`);
    }
    if (list.length > 40) console.log(`  …还有 ${list.length - 40} 件`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
