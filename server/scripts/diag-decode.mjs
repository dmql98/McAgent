/**
 * 诊断：对指定工具跑一次真实解码，打印
 *   - extractText 拿到的文本段数与长度
 *   - decodeToolResult 返回的类型
 *   - 若是字符串，看看它是不是「说明文字 + JSON」的多段拼接
 *
 * 用法：node scripts/diag-decode.mjs <userId> <toolName> '<argsJson>'
 */
const [userId, tool, argsJson] = process.argv.slice(2);
if (!userId || !tool) {
  console.error(`用法：node scripts/diag-decode.mjs <userId> <toolName> '<argsJson>'`);
  process.exit(1);
}

const gw = await import('../dist/mcp/gateway.js');
const toon = await import('../dist/mcp/toon.js');
const args = argsJson ? JSON.parse(argsJson) : {};

const env = await gw.callToolEnvelope(userId, tool, args, { cacheTtl: null });

console.log('costMs =', env.costMs, ' cached =', env.cached);
console.log('rawText 有值 =', typeof env.rawText === 'string', ' len =', env.rawText?.length ?? 0);

const d = env.data;
console.log('data 类型 =', typeof d, Array.isArray(d) ? 'ARRAY' : '');
if (typeof d === 'string') {
  console.log('data 是字符串，前 200 字符：');
  console.log(d.slice(0, 200));
  console.log('…后 200 字符：');
  console.log(d.slice(-200));
  const again = toon.parseLoose(d);
  console.log('对 data 再 parseLoose 一次 → 类型 =', typeof again, Array.isArray(again) ? 'ARRAY' : '');
  if (typeof again !== 'string') {
    console.log('  keys/data 长度 =', Array.isArray(again) ? again.length : Object.keys(again ?? {}));
  }
} else if (d && typeof d === 'object') {
  console.log('data keys =', Object.keys(d));
  const arr = d.data;
  console.log('data.data 是数组 =', Array.isArray(arr), ' 长度 =', Array.isArray(arr) ? arr.length : 'n/a');
  if (Array.isArray(arr) && arr[0]) console.log('首条 keys =', Object.keys(arr[0]));
}

await gw.shutdownGateway();
process.exit(0);
