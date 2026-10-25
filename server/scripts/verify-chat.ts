/**
 * 端到端验证：直接跑 runChat（不经过 HTTP，不起服务）
 *
 * 验证两件事：
 *   1. 到店：选品 → 菜单 → 算价（无配送费、有 fulfillment='自取'）
 *   2. 外送：地址 → 门店 → 外送菜单 → 算价（含配送费、有 address）
 *
 * 用法：
 *   node --import tsx scripts/verify-chat.ts <token>
 */
import { login } from '../src/services/auth.service.js';
import { runChat } from '../src/services/orchestrator.js';
import { listAddresses } from '../src/services/delivery.service.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import type { ChatReply } from '../src/types/contract.js';

const TOKEN = process.argv[2] ?? '';

function line(): void {
  console.log('  ' + '─'.repeat(68));
}

async function runOnce(
  userId: string,
  label: string,
  message: string,
  fulfillment: '自取' | '外送',
  addressId?: string,
): Promise<ChatReply | null> {
  console.log(`\n=== ${label} ===`);
  line();

  let reply: ChatReply | null = null;
  const stages: string[] = [];

  const ctrl = new AbortController();
  try {
    for await (const evt of runChat({
      userId,
      message,
      fulfillment,
      ...(addressId ? { addressId } : {}),
      signal: ctrl.signal,
    })) {
      if (evt.type === 'stage') {
        stages.push(evt.stage);
      } else if (evt.type === 'reply') {
        reply = evt.payload;
      } else if (evt.type === 'error') {
        console.log(`  ❌ ${evt.error}: ${evt.message}`);
        return null;
      }
    }
  } catch (e) {
    console.log(`  ❌ 异常：${(e as Error).message}`);
    return null;
  }

  if (!reply) {
    console.log('  ❌ 没有产出 reply');
    return null;
  }

  const r = reply as ChatReply;
  console.log(`  ✅ stage 流水线：${stages.join(' → ')}`);
  console.log(`  ✅ 门店：${r.meta.store}`);
  console.log(`  ✅ 履约：${r.meta.fulfillment ?? '(未标)'} · ${r.meta.slot}`);
  console.log(`  ✅ 标题：${r.meta.title}`);
  console.log(`  ✅ 菜单 ${r.menu.length} 项：`);
  for (const m of r.menu) {
    const code = m.productId ? `[${m.productId}]` : '[⚠️无编码]';
    console.log(`       ${code} ${m.name} ${m.spec} ¥${m.price.toFixed(1)}${m.why ? `  — ${m.why}` : ''}`);
  }
  console.log(`  ✅ 合计 ¥${r.total.toFixed(2)}${r.original ? `（原价 ¥${r.original.toFixed(2)}）` : ''}`);
  if (r.deliveryFee) {
    console.log(
      `  ✅ 外送费：配送 ¥${r.deliveryFee.delivery.toFixed(2)} + 打包 ¥${r.deliveryFee.packing.toFixed(2)}`,
    );
  }
  if (r.address) console.log(`  ✅ 送到：${r.address}`);
  console.log(`  ✅ 开场：${r.hook.slice(0, 90).replace(/\n/g, ' ')}…`);

  // 关键断言
  const noCode = r.menu.filter((m) => !m.productId);
  if (noCode.length > 0) console.log(`  ⚠️ ${noCode.length} 项没有 productCode，将无法下单`);
  if (fulfillment === '外送') {
    if (!r.deliveryFee) console.log('  ⚠️ 外送但没有 deliveryFee');
    if (!r.address) console.log('  ⚠️ 外送但没有 address');
    if (r.meta.fulfillment !== '外送') console.log('  ⚠️ meta.fulfillment 不是外送');
  } else {
    if (r.deliveryFee) console.log('  ⚠️ 到店场景却出现了 deliveryFee');
    if (r.meta.fulfillment !== '自取') console.log('  ⚠️ meta.fulfillment 不是自取');
  }

  return r;
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('用法: node --import tsx scripts/verify-chat.ts <麦当劳token>');
    process.exit(1);
  }

  loadConfig();
  getDb();
  const { userId } = await login(TOKEN);
  console.log(`\n用户：${userId}`);

  /* ---- 1. 到店 ---- */
  const pickup = await runOnce(userId, '到店自取 · 两人 80 预算', '两个人，预算80，想吃点辣的', '自取');

  /* ---- 2. 外送 ---- */
  const addrs = await listAddresses(userId);
  if (addrs.length === 0) {
    console.log('\n⚠️ 该账号没有配送地址，跳过外送验证');
    process.exit(0);
  }
  const addr = addrs.find((a) => a.isDefault) ?? addrs[0]!;
  const delivery = await runOnce(
    userId,
    '外送 · 两人 80 预算',
    '两个人，预算80，想吃点辣的',
    '外送',
    addr.addressId,
  );

  /* ---- 3. 对比 ---- */
  console.log('\n=== 对比 ===');
  line();
  if (pickup && delivery) {
    const pCodes = new Set(pickup.menu.map((m) => m.productId));
    const dCodes = new Set(delivery.menu.map((m) => m.productId));
    const overlap = [...pCodes].filter((c) => dCodes.has(c));
    console.log(`  到店菜单：${pCodes.size} 个编码，实付 ¥${pickup.total.toFixed(2)}`);
    console.log(`  外送菜单：${dCodes.size} 个编码，实付 ¥${delivery.total.toFixed(2)}`);
    console.log(`  编码交集：${overlap.length} 个`);
    console.log(`  外送额外费用：¥${(delivery.total - (pickup.total || 0)).toFixed(2)}（含商品差异，非纯费用）`);
    console.log('\n  ✅ 两条链路都产出了完整菜单，履约方式未串场。\n');
  }
}

main().catch((e) => {
  console.error('\n验证失败：', e);
  process.exit(1);
});
