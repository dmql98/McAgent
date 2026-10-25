/**
 * 双链路真实验证脚本（不做真实建单，不产生费用）
 *
 * 验证内容：
 *   1. 到店链路：query-nearby-stores → query-meals(orderType=1) → calculate-price(orderType=1)
 *   2. 外送链路：delivery-query-addresses → delivery-query-stores(beType=2)
 *                → query-meals(orderType=2, beCode) → calculate-price(orderType=2, addressId, beCode)
 *   3. 两套商品编码的交集比例（解释为什么必须在开局选）
 *
 * 用法：
 *   node --import tsx scripts/verify-fulfillment.ts <token>
 */
import { getDecryptedToken, login } from '../src/services/auth.service.js';
import { callTool } from '../src/mcp/gateway.js';
import {
  adaptStores,
  adaptProducts,
  adaptPrice,
  adaptAddresses,
} from '../src/services/mcp-adapter.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const TOKEN = process.argv[2] ?? '';

function ok(label: string, detail = ''): void {
  console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label: string, detail = ''): void {
  console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`);
}
function line(): void {
  console.log('  ' + '─'.repeat(66));
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('用法: node --import tsx scripts/verify-fulfillment.ts <麦当劳token>');
    process.exit(1);
  }

  loadConfig();
  getDb();

  /* ---- 注入 token（走真实 login 链路） ---- */
  const { userId } = await login(TOKEN);
  const token = getDecryptedToken(userId);
  if (!token) throw new Error('token 注入失败');
  console.log('\n=== 0. Token ===');
  ok('登录并解密成功', `userId=${userId} · ${token.slice(0, 6)}…${token.slice(-4)}`);

  /* ================= 到店链路 ================= */
  console.log('\n=== 1. 到店链路（orderType=1 / beType=1） ===');
  line();

  let pickupStoreCode = '';
  let pickupBeCode = '';
  try {
    const raw = await callTool(userId, 'query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city: '厦门市',
      keyword: '麦当劳',
    });
    const stores = adaptStores(raw);
    if (stores.length === 0) throw new Error('没搜到门店');
    const s = stores[0]!;
    pickupStoreCode = s.storeCode;
    pickupBeCode = s.beCode ?? '';
    ok('query-nearby-stores', `${s.name} (${s.storeCode}) · 共 ${stores.length} 家`);
  } catch (e) {
    bad('query-nearby-stores', (e as Error).message);
    process.exit(1);
  }

  let pickupProducts: ReturnType<typeof adaptProducts> = [];
  try {
    const raw = await callTool(userId, 'query-meals', {
      storeCode: pickupStoreCode,
      orderType: 1,
      beType: 1,
      ...(pickupBeCode ? { beCode: pickupBeCode } : {}),
    });
    pickupProducts = adaptProducts(raw);
    const sellable = pickupProducts.filter((p) => !p.withOrderOnly && p.available !== false);
    ok(
      'query-meals',
      `${pickupProducts.length} 件；可售 ${sellable.length} 件；带编码 ${pickupProducts.filter((p) => p.productId).length} 件`,
    );
  } catch (e) {
    bad('query-meals', (e as Error).message);
    process.exit(1);
  }

  // 到店算价：取 3 件可售商品各 1 份
  const pickupPick = pickupProducts
    .filter((p) => p.productId && !p.withOrderOnly && p.available !== false)
    .slice(0, 3)
    .map((p) => ({ productCode: p.productId!, quantity: 1 }));

  if (pickupPick.length > 0) {
    try {
      const raw = await callTool(userId, 'calculate-price', {
        storeCode: pickupStoreCode,
        orderType: 1,
        beType: 1,
        items: pickupPick,
      });
      const info = adaptPrice(raw);
      if (!info) throw new Error('无法解析');
      ok(
        'calculate-price（到店）',
        `¥${info.total.toFixed(2)}` +
          (info.takeWay ? ` · takeWayCode=${info.takeWay.code}（${info.takeWay.title}）` : ' · ⚠️ 无 takeWayList') +
          (info.deliveryFee ? ` · ⚠️ 竟有配送费 ¥${info.deliveryFee}` : ' · 无配送费 ✓'),
      );
    } catch (e) {
      bad('calculate-price（到店）', (e as Error).message);
    }
  }

  /* ================= 外送链路 ================= */
  console.log('\n=== 2. 外送链路（orderType=2 / beType=2） ===');
  line();

  let addrId = '';
  let addrText = '';
  try {
    const raw = await callTool(userId, 'delivery-query-addresses', {});
    const addrs = adaptAddresses(raw);
    if (addrs.length === 0) {
      bad('delivery-query-addresses', '这个账号没有配送地址（需要先在 App 里建一个）');
      console.log('\n结论：无法验证外送算价，但到店链路已验证。\n');
      process.exit(0);
    }
    const a = addrs.find((x) => x.isDefault) ?? addrs[0]!;
    addrId = a.addressId;
    addrText = `${a.contactName} ${a.phone} ${a.fullAddress}`;
    ok('delivery-query-addresses', `${addrs.length} 个地址 · 用 ${addrText}`);
  } catch (e) {
    bad('delivery-query-addresses', (e as Error).message);
    process.exit(1);
  }

  let dvStoreCode = '';
  let dvBeCode = '';
  try {
    const raw = await callTool(userId, 'delivery-query-stores', { addressId: addrId, beType: 2 });
    const stores = adaptStores(raw);
    if (stores.length === 0) throw new Error('该地址无可配送门店');
    const s = stores[0]!;
    dvStoreCode = s.storeCode;
    dvBeCode = s.beCode ?? '';
    ok(
      'delivery-query-stores',
      `${s.name} (${s.storeCode}) · beCode=${dvBeCode || '⚠️ 缺失'} · 共 ${stores.length} 家`,
    );
    if (!dvBeCode) throw new Error('外送门店没有 beCode，无法继续');
  } catch (e) {
    bad('delivery-query-stores', (e as Error).message);
    process.exit(1);
  }

  let dvProducts: ReturnType<typeof adaptProducts> = [];
  try {
    const raw = await callTool(userId, 'query-meals', {
      storeCode: dvStoreCode,
      orderType: 2,
      beType: 2,
      beCode: dvBeCode,
    });
    dvProducts = adaptProducts(raw);
    const sellable = dvProducts.filter((p) => !p.withOrderOnly && p.available !== false);
    ok('query-meals（外送）', `${dvProducts.length} 件；可售 ${sellable.length} 件`);
  } catch (e) {
    bad('query-meals（外送）', (e as Error).message);
    process.exit(1);
  }

  // 外送算价
  const dvPick = dvProducts
    .filter((p) => p.productId && !p.withOrderOnly && p.available !== false)
    .slice(0, 3)
    .map((p) => ({ productCode: p.productId!, quantity: 1 }));

  if (dvPick.length > 0) {
    try {
      const raw = await callTool(userId, 'calculate-price', {
        storeCode: dvStoreCode,
        orderType: 2,
        beType: 2,
        beCode: dvBeCode,
        addressId: addrId,
        items: dvPick,
      });
      const info = adaptPrice(raw);
      if (!info) throw new Error('无法解析');
      const productSum = dvProducts
        .filter((p) => dvPick.some((x) => x.productCode === p.productId))
        .reduce((s, p) => s + p.price, 0);
      ok(
        'calculate-price（外送）',
        `¥${info.total.toFixed(2)}` +
          ` · 配送费 ${info.deliveryFee !== undefined ? '¥' + info.deliveryFee.toFixed(2) : '⚠️ 无'}` +
          ` · 打包费 ${info.packingFee !== undefined ? '¥' + info.packingFee.toFixed(2) : '0'}` +
          (info.takeWay ? ' · ⚠️ 竟有 takeWayCode' : ' · 无 takeWayList ✓'),
      );
      ok(
        '费用校验',
        `商品价合计 ¥${productSum.toFixed(2)}；实付 ¥${info.total.toFixed(2)}；差额 ¥${(info.total - productSum).toFixed(2)}（应≈配送费+打包费）`,
      );
    } catch (e) {
      bad('calculate-price（外送）', (e as Error).message);
    }
  }

  /* ================= 编码交集 ================= */
  console.log('\n=== 3. 两套商品编码的差异（解释「必须开局选」） ===');
  line();

  const pickupCodes = new Set(pickupProducts.map((p) => p.productId).filter(Boolean) as string[]);
  const dvCodes = new Set(dvProducts.map((p) => p.productId).filter(Boolean) as string[]);
  const both = [...pickupCodes].filter((c) => dvCodes.has(c));

  ok('到店商品编码', `${pickupCodes.size} 个`);
  ok('外送商品编码', `${dvCodes.size} 个`);
  ok('两者交集', `${both.length} 个`);
  const onlyPickup = pickupCodes.size - both.length;
  console.log(
    `\n  结论：到店 ${pickupCodes.size} 个编码里有 ${onlyPickup} 个在外送不存在` +
      `（${((onlyPickup / Math.max(1, pickupCodes.size)) * 100).toFixed(1)}%）。`,
  );
  console.log('  所以「先按到店选品、下单时再切外送」必然失败 —— 必须在对话开局就定下来。\n');
}

main().catch((e) => {
  console.error('\n验证失败：', e);
  process.exit(1);
});
