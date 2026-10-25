/**
 * 打印某个工具的真实 MCP 返回结构（绕过缓存，直连 MCP）。
 * 用途：确认 extractText / decodeToolResult 为什么取不到东西。
 *
 * 用法：node scripts/dump-raw.mjs <userId> <toolName> '<argsJson>'
 */
const [userId, tool, argsJson] = process.argv.slice(2);
if (!userId || !tool) {
  console.error(`用法：node scripts/dump-raw.mjs <userId> <toolName> '<argsJson>'`);
  process.exit(1);
}

const gw = await import('../dist/mcp/gateway.js');
const args = argsJson ? JSON.parse(argsJson) : {};

// 借一次普通调用把连接建起来，随后直接拿池里的 client
const probe = await gw.callToolEnvelope(userId, 'now-time-info', {}, { cacheTtl: null });
console.log('探测调用 ok，cost=', probe.costMs);

const { getPooledClient } = gw;
const entry = await getPooledClient(userId);
const raw = await entry.client.callTool({ name: tool, arguments: args });

console.log('\n=== 顶层 keys ===', Object.keys(raw ?? {}));
console.log('=== content 是数组 ===', Array.isArray(raw?.content));
if (Array.isArray(raw?.content)) {
  console.log('content 段数:', raw.content.length);
  raw.content.forEach((c, i) => {
    console.log(`  [${i}] type=${c?.type} textLen=${typeof c?.text === 'string' ? c.text.length : 'n/a'}`);
  });
}
console.log('=== 有 structuredContent ===', 'structuredContent' in (raw ?? {}));
console.log('\n=== 原始 JSON 前 1000 字符 ===');
console.log(JSON.stringify(raw, null, 2)?.slice(0, 1000));

await gw.shutdownGateway();
process.exit(0);
