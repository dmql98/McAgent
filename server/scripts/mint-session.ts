/**
 * 给已有用户临时签一个会话 JWT，用于本地验证购物车 REST 接口。
 *
 * 只签 JWT，不碰数据库里的 token_enc —— 所以即使 MCP token 已失效，
 * 购物车的增删改（纯本地 DB 操作）依然能验证。
 *
 * 用法：npx tsx scripts/mint-session.ts [userId]
 */
import jwt from 'jsonwebtoken';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/db/index.js';

function main(): void {
  const cfg = loadConfig();
  const want = process.argv[2];
  const db = getDb();

  const row = want
    ? db.prepare('SELECT user_id, nickname FROM users WHERE user_id = ?').get<{ user_id: string; nickname: string | null }>(want)
    : db.prepare('SELECT user_id, nickname FROM users ORDER BY created_at DESC LIMIT 1').get<{ user_id: string; nickname: string | null }>();

  if (!row) {
    console.error('数据库里没有这个用户');
    process.exit(1);
  }

  const token = jwt.sign({ sub: row.user_id }, cfg.jwtSecret, {
    expiresIn: cfg.jwtTtlSeconds,
    algorithm: 'HS256',
  });

  console.error(`# user=${row.user_id} nickname=${row.nickname ?? '-'}`);
  console.log(token);
}

main();
