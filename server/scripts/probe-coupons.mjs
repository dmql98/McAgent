/**
 * 临时探测：用库里已存的 token 实测券相关工具的**真实返回**
 * 只读，不改任何数据。输出脱敏（不打印 token）。
 */
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

function decrypt(payload, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

const db = new DatabaseSync('./data/mcd.db');
const row = db.prepare('SELECT user_id, token_enc FROM users ORDER BY updated_at DESC LIMIT 1').get();
const token = decrypt(row.token_enc, env.TOKEN_ENC_KEY);
console.log('使用用户', row.user_id, 'token 长度', token.length);

const transport = new StreamableHTTPClientTransport(new URL('https://mcp.mcd.cn'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'probe2', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const probes = [
  ['query-my-account', {}],
  ['query-my-coupons', { page: '1', pageSize: '20' }],
  ['available-coupons', {}],
  ['campaign-calendar', {}],
  ['order-list', {}],
  ['now-time-info', {}],
];

for (const [name, args] of probes) {
  const t = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const text =
      res?.content?.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') ??
      JSON.stringify(res);
    console.log(`\n${'='.repeat(78)}\n[${name}] isError=${Boolean(res?.isError)} ${Date.now() - t}ms\n${'='.repeat(78)}`);
    console.log(text.slice(0, 4000));
  } catch (e) {
    console.log(`\n[${name}] THREW ${Date.now() - t}ms: ${String(e?.message ?? e).slice(0, 400)}`);
  }
}

await client.close();
