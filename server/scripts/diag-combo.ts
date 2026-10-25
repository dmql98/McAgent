/**
 * 套餐组成普查：MCP 返回的套餐到底带不带 combo 明细？
 * 这决定「套餐已有饮料就不再补一杯」能不能靠字段精确判断。
 *
 * node --import tsx scripts/diag-combo.ts <token> [外送|自取]
 */
import { login } from '../src/services/auth.service.js';
import { callTool } from '../src/mcp/gateway.js';
import { adaptProducts, adaptStores, adaptAddresses } from '../src/services/mcp-adapter.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const [TOKEN = '', fulf = '外送'] = process.argv.slice(2);
const isComboName = (n: string) => /套餐|件套|单人餐|双人餐|多人餐|分享餐|随心选|随心配|组合|拼盘/.test(n ?? '');

async function main() {
  loadConfig();
  getDb();
  const { userId } = await login(TOKEN);

  let products;
  if (fulf === '外送') {
    const addrs = adaptAddresses(await callTool(userId, 'delivery-query-addresses', {}));
    const addr = addrs.find((a) => a.isDefault) ?? addrs[0]!;
    const stores = adaptStores(
      await callTool(userId, 'delivery-query-stores', { addressId: addr.addressId, beType: 2 }),
    );
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

  const combos = products.filter((p) => isComboName(p.name));
  const withCombo = combos.filter((p) => Array.isArray(p.combo) && p.combo!.length > 0);

  console.log(`\n=== ${fulf} 菜单 ${products.length} 件，其中套餐类 ${combos.length} 件 ===`);
  console.log(`带 combo 明细的套餐：${withCombo.length} / ${combos.length}\n`);

  if (withCombo.length === 0) {
    console.log('⚠️ combo 明细为空 —— 无法靠字段判断套餐组成，需走启发式');
    console.log('\n前 8 个套餐的全部原始字段键名：');
    for (const p of combos.slice(0, 8)) {
      console.log(`\n· ${p.name}  ¥${p.price}`);
      console.log(`  keys: ${Object.keys(p).join(', ')}`);
    }
  } else {
    for (const p of withCombo.slice(0, 30)) {
      console.log(`· ${p.name}  ¥${p.price}`);
      console.log(`  → ${p.combo!.join(' / ')}`);
    }
  }

  // 顺带看看双人餐候选
  const dbl = products.filter((p) => /双人|两人|2\s*人/.test(p.name ?? ''));
  console.log(`\n=== 双人餐 ${dbl.length} 件 ===`);
  for (const p of dbl) console.log(`  ¥${String(p.price).padStart(6)}  ${p.name}  combo=${(p.combo ?? []).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
