/**
 * MCP 冒烟测试 CLI
 *
 * 用途：拿到真实 Token 后，第一时间验证 13 个工具哪些通、哪些不通、
 * 返回结构长什么样。联调时最有价值的一步。
 *
 * 用法：
 *   npx tsx scripts/mcp-smoke.ts <TOKEN>
 *   npx tsx scripts/mcp-smoke.ts <TOKEN> --raw          # 打印原始响应（脱敏）
 *   npx tsx scripts/mcp-smoke.ts <TOKEN> --only stores,products
 *
 * ⚠️ 只读为主。create-order 需要 --write 显式开启，且默认只建 1 个最便宜的单品。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = process.env.MCP_ENDPOINT ?? 'https://mcp.mcd.cn';

/* ------------------------------------------------------------------ */
/* 参数                                                              */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const token = args.find((a) => !a.startsWith('--'));
const showRaw = args.includes('--raw');
const allowWrite = args.includes('--write');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

if (!token) {
  console.error(`
用法：npx tsx scripts/mcp-smoke.ts <TOKEN> [--raw] [--only=tool1,tool2] [--write]

  <TOKEN>   麦当劳 MCP Token（open.mcd.cn 获取）
  --raw     打印原始响应（Token 已脱敏）
  --only    只测指定的工具
  --write   允许调用写操作（create-order），默认跳过
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 脱敏                                                              */
/* ------------------------------------------------------------------ */

const SENSITIVE = /(bearer\s+)([a-z0-9._-]{8,})|("?(?:token|apiKey|secret|authorization)"?\s*[:=]\s*"?)([a-z0-9._-]{8,})/gi;

function sanitize(s: string): string {
  return s
    .replace(SENSITIVE, (_m, p1?: string, _t?: string, p3?: string) =>
      p1 ? `${p1}****` : `${p3 ?? ''}****`,
    )
    .replace(new RegExp(escapeRe(token!), 'g'), mask(token!));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mask(s: string): string {
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* 待测工具清单                                                       */
/* ------------------------------------------------------------------ */

interface Probe {
  name: string;
  args: Record<string, unknown>;
  write?: boolean;
  note: string;
}

const PROBES: Probe[] = [
  { name: 'now-time-info', args: {}, note: '当前时间/门店营业状态（登录校验用它）' },
  { name: 'query-store', args: {}, note: '门店列表' },
  { name: 'query-nearby-store', args: { latitude: 22.5347, longitude: 113.9305 }, note: '附近门店' },
  { name: 'query-product', args: {}, note: '商品/菜单' },
  { name: 'query-product-detail', args: { productId: 'MOCK-BIGMAC' }, note: '商品详情（id 待确认）' },
  { name: 'query-nutrition', args: { productId: 'MOCK-BIGMAC' }, note: '营养信息' },
  { name: 'query-coupon', args: {}, note: '我的优惠券' },
  { name: 'query-order', args: { orderId: 'NON_EXISTENT' }, note: '订单查询（预期报错=接口通）' },
];

const WRITE_PROBES: Probe[] = [
  { name: 'calculate-price', args: { items: [] }, note: '价格试算', write: false },
  {
    name: 'create-order',
    args: { items: [{ productId: 'MOCK-CONE', quantity: 1 }], fulfillment: 'pickup' },
    note: '⚠️ 会真建单！确认要试再加 --write',
    write: true,
  },
];

/* ------------------------------------------------------------------ */
/* 执行                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('='.repeat(64));
  console.log('MCP 冒烟测试');
  console.log(`端点：${ENDPOINT}`);
  console.log(`Token：${mask(token!)}`);
  console.log(`写操作：${allowWrite ? '⚠️ 已开启' : '跳过（加 --write 开启）'}`);
  console.log('='.repeat(64));

  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  const client = new Client({ name: 'mcd-soulmate-smoke', version: '1.0.0' }, { capabilities: {} });

  const t0 = Date.now();
  try {
    await client.connect(transport);
  } catch (err) {
    console.error(`\n❌ 连接失败（${Date.now() - t0}ms）：${sanitize((err as Error).message)}`);
    process.exit(1);
  }
  console.log(`\n✅ 连接成功（${Date.now() - t0}ms）\n`);

  /* ---- 列出工具 ---- */
  let listed: string[] = [];
  try {
    const tools = await client.listTools();
    listed = (tools.tools ?? []).map((t) => t.name);
    console.log(`服务端声明 ${listed.length} 个工具：`);
    for (const t of tools.tools ?? []) {
      const params = Object.keys((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});
      console.log(`  · ${t.name}${t.description ? ` — ${t.description.slice(0, 60)}` : ''}`);
      if (params.length) console.log(`      参数：${params.join(', ')}`);
    }
    console.log('');
  } catch (err) {
    console.warn(`listTools 失败：${sanitize((err as Error).message)}\n`);
  }

  /* ---- 逐个探测 ---- */
  const probes = allowWrite ? [...PROBES, ...WRITE_PROBES] : [...PROBES, WRITE_PROBES[0]!];
  const results: Array<{ name: string; ok: boolean; ms: number; note: string; detail: string }> = [];

  for (const p of probes) {
    if (only && !only.includes(p.name)) continue;
    if (p.write && !allowWrite) continue;
    if (listed.length > 0 && !listed.includes(p.name)) {
      results.push({ name: p.name, ok: false, ms: 0, note: p.note, detail: '服务端未声明此工具' });
      console.log(`  ⏭  ${p.name} — 服务端未声明，跳过`);
      continue;
    }

    const start = Date.now();
    try {
      const res = await client.callTool({ name: p.name, arguments: p.args });
      const ms = Date.now() - start;

      const isErr = Boolean((res as { isError?: boolean }).isError);
      const text = extractText(res);
      const detail = showRaw ? sanitize(text.slice(0, 1200)) : summarize(text);

      results.push({
        name: p.name,
        ok: !isErr,
        ms,
        note: p.note,
        detail: isErr ? `工具返回错误：${detail}` : detail,
      });

      console.log(`  ${isErr ? '⚠️ ' : '✅'} ${p.name} (${ms}ms)`);
      console.log(`      ${detail.replace(/\n/g, '\n      ')}`);
    } catch (err) {
      const ms = Date.now() - start;
      const msg = sanitize((err as Error).message);
      results.push({ name: p.name, ok: false, ms, note: p.note, detail: msg });
      console.log(`  ❌ ${p.name} (${ms}ms) — ${msg}`);
    }
  }

  /* ---- 汇总 ---- */
  console.log('\n' + '='.repeat(64));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`结果：${okCount}/${results.length} 可用`);
  console.log('='.repeat(64));

  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(24)} ${String(r.ms).padStart(6)}ms  ${r.note}`);
  }

  console.log('\n待人工确认清单（docs/mcp-tools.md §待联调确认）：');
  console.log('  1. query-product 的真实返回字段名（name/price/productId 是否叫这个）');
  console.log('  2. create-order 的必填入参（storeId? items[].productId? fulfillment 枚举值?）');
  console.log('  3. query-order 的 status 取值范围（是否与 order.service.ts 的 STATUS_MAP 一致）');
  console.log('  4. payUrl 是链接还是二维码图（决定前端展示方式）');
  console.log('  5. query-store 是否需要经纬度参数');

  await client.close();
}

function extractText(res: unknown): string {
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return JSON.stringify(res);
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

/** 不打印全文时，只给出结构摘要（字段名 + 数组长度），便于判断字段结构 */
function summarize(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '(空响应)';

  try {
    const data = JSON.parse(trimmed) as unknown;
    return describe(data, 0);
  } catch {
    // TOON 或其他格式：给前 300 字符
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }
}

function describe(v: unknown, depth: number): string {
  const pad = '  '.repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[] (空数组)';
    const first = describe(v[0], depth + 1);
    return `Array(${v.length}) [\n${pad}  ${first}\n${pad}]`;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    const lines = entries.slice(0, 12).map(([k, val]) => `${pad}  ${k}: ${scalar(val)}`);
    if (entries.length > 12) lines.push(`${pad}  …还有 ${entries.length - 12} 个字段`);
    return `{\n${lines.join('\n')}\n${pad}}`;
  }
  return scalar(v);
}

function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  if (typeof v === 'object') return Array.isArray(v) ? `Array(${v.length})` : '{…}';
  return String(v);
}

main().catch((err) => {
  console.error('\n❌ 冒烟测试异常：', sanitize((err as Error).message));
  process.exit(1);
});
