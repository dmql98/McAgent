/**
 * 探测脚本：导出完整 tools/list + 实测核心只读工具的真实返回结构
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = 'https://mcp.mcd.cn';
const token = process.argv[2];
const probes = (process.argv[3] ?? '')
  .split('|')
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf('=');
    const name = i === -1 ? s : s.slice(0, i);
    const argsJson = i === -1 ? undefined : s.slice(i + 1);
    return { name, args: argsJson ? JSON.parse(argsJson) : {} };
  });

const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

if (probes.length === 0) {
  // 只导出工具清单
  const tools = await client.listTools();
  const out = (tools.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const p of probes) {
    const start = Date.now();
    try {
      const res = await client.callTool({ name: p.name, arguments: p.args });
      const isErr = Boolean(res?.isError);
      const text = res?.content
        ?.filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('\n') ?? JSON.stringify(res);
      console.log(`\n${'='.repeat(70)}\n[TOOL] ${p.name} args=${JSON.stringify(p.args)} ${isErr ? 'isError' : 'OK'} (${Date.now() - start}ms)\n${'='.repeat(70)}`);
      console.log(text.slice(0, 3000));
    } catch (err) {
      console.log(`\n${'='.repeat(70)}\n[TOOL] ${p.name} args=${JSON.stringify(p.args)} THREW (${Date.now() - start}ms)\n${'='.repeat(70)}`);
      console.log(String(err?.message ?? err).slice(0, 800));
    }
  }
}
await client.close();
