/**
 * 临时探测：query-meals 真实返回结构（只读）
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
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const db = new DatabaseSync('./data/mcd.db');
const row = db.prepare('SELECT user_id, token_enc FROM users ORDER BY updated_at DESC LIMIT 1').get();
const token = decrypt(row.token_enc, env.TOKEN_ENC_KEY);

const transport = new StreamableHTTPClientTransport(new URL('https://mcp.mcd.cn'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'p3', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

function textOf(res) {
  return res?.content?.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') ?? '';
}

const stores = await client.callTool({
  name: 'query-nearby-stores',
  arguments: { beType: 1, searchType: 2, city: '厦门市', keyword: '集美' },
});
const storeText = textOf(stores);
const jsonMatch = storeText.match(/\{"success"[\s\S]*\}/);
const storeJson = JSON.parse(jsonMatch[0]);
const firstStore = storeJson.data[0];
console.log('STORE:', JSON.stringify(firstStore).slice(0, 400));

const meals = await client.callTool({
  name: 'query-meals',
  arguments: { storeCode: firstStore.storeCode, orderType: 1, beType: 1 },
});
const mealText = textOf(meals);
console.log('\n--- meals raw len', mealText.length);
const mi = mealText.match(/\{"success"[\s\S]*\}/);
if (mi) {
  const mj = JSON.parse(mi[0]);
  const d = mj.data;
  console.log('top keys:', Object.keys(d));
  console.log('categories[0]:', JSON.stringify(d.categories?.[0])?.slice(0, 500));
  console.log('categories count:', d.categories?.length);
  const firstMealKey = Object.keys(d.meals ?? {})[0];
  console.log('meals count:', Object.keys(d.meals ?? {}).length);
  console.log('meal sample key=', firstMealKey, JSON.stringify(d.meals?.[firstMealKey]));
  console.log('frequent sample:', JSON.stringify(d.frequent)?.slice(0, 300));
} else {
  console.log(mealText.slice(0, 1500));
}

const sc = await client.callTool({
  name: 'query-store-coupons',
  arguments: { storeCode: firstStore.storeCode, orderType: 1, beType: 1 },
});
console.log('\n--- store-coupons ---\n', textOf(sc).slice(0, 1200));

await client.close();
