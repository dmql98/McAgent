/**
 * 数据面冒烟：逐个打数据面 GET 接口，打印状态码、耗时、每块的 MCP 来源与条数。
 * 目的不是断言业务正确，而是确认「35 个工具 → 面板接口」这条链路没有断。
 *
 * 接口有两种返回形态：
 *   单块：{ meta, data }
 *   多块：{ 块名: { meta, data }, ... }   —— 例如 overview / coupons / points
 * 所以这里要递归找所有带 meta 的节点，不能只看顶层。
 *
 * 用法：node scripts/probe-explorer.mjs <jwt>
 */
const JWT = process.argv[2];
if (!JWT) {
  console.error('用法：node scripts/probe-explorer.mjs <jwt>');
  process.exit(1);
}

const BASE = 'http://127.0.0.1:3000';

/**
 * 服务端有全局限流（默认 30 req/min/IP），逐个连打会撞 429。
 * 这里默认每个请求间隔 2.1 秒，让 11 个接口稳稳跑完。
 * 想跑快就传 --fast（前提是服务端设了 RATE_LIMIT_DISABLED=1）。
 */
const FAST = process.argv.includes('--fast');
const GAP_MS = FAST ? 0 : 2100;

/** 粗估一块数据里「有几个东西」 */
function shape(data) {
  if (data == null) return 'null';
  if (Array.isArray(data)) return `${data.length} 条`;
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    const arrKey = keys.find((k) => Array.isArray(data[k]));
    if (arrKey) return `${arrKey}:${data[arrKey].length}`;
    return `{${keys.slice(0, 3).join(',')}}`;
  }
  return String(data);
}

/** 递归收集 {路径, meta, data} */
function collectBlocks(node, path = '', out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  if (node.meta && typeof node.meta === 'object') {
    // 有些接口把数据放在 rows 而不是 data（营养表就是），这里一并兼容
    out.push({ path, meta: node.meta, data: node.data ?? node.rows });
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    collectBlocks(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

const ROUTES = [
  '/api/explorer/overview',
  '/api/explorer/stores?city=上海&pageSize=3',
  '/api/explorer/nutrition',
  '/api/explorer/coupons',
  '/api/explorer/points',
  '/api/explorer/mall',
  '/api/explorer/orders?page=1',
  '/api/explorer/campaigns',
  '/api/explorer/parties?cityCode=310100',
  '/api/explorer/addresses',
  '/api/explorer/tools',
];

let ok = 0;
let bad = 0;
let blocks = 0;
let fromMcp = 0;
let fromCache = 0;
let fromEmpty = 0;

for (const [i, path] of ROUTES.entries()) {
  if (i > 0 && GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS));
  const t0 = Date.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(BASE + path, { headers: { Cookie: `mcd_sid=${JWT}` } });
    status = res.status;
    body = await res.json();
  } catch (e) {
    console.log(`✗ ${path}  请求异常：${e.message}`);
    bad++;
    continue;
  }
  const ms = Date.now() - t0;
  if (status === 200) ok++;
  else bad++;
  console.log(`${status === 200 ? '✓' : '✗'} ${String(status).padEnd(3)} ${String(ms + 'ms').padEnd(7)} ${path}`);
  if (status !== 200) {
    console.log(`    ↳ ${JSON.stringify(body).slice(0, 160)}`);
    continue;
  }
  const list = collectBlocks(body);
  if (!list.length) console.log('    （无数据块）');
  for (const b of list) {
    blocks++;
    const s = b.meta.source ?? '?';
    if (s === 'mcp') fromMcp++;
    else if (s === 'cache') fromCache++;
    else fromEmpty++;
    const title = b.path.padEnd(18);
    const tool = String(b.meta.tool ?? '—').padEnd(26);
    const extra = s === 'empty' ? `  ← ${b.meta.reason ?? ''}` : '';
    console.log(`    ${title} ${s.padEnd(6)} ${tool} ${shape(b.data).padEnd(20)}${extra}`);
  }
}

console.log(
  `\n接口 ${ok}/${ROUTES.length} 通过，${bad} 失败` +
    `　数据块 ${blocks} 个：mcp ${fromMcp} / cache ${fromCache} / empty ${fromEmpty}`,
);
