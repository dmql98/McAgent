/**
 * 认证服务：Token 登录 / 登录态 / 解绑
 *
 * 设计要点（PRD §3）：
 * - Token 即身份、即授权，不设手机号/微信
 * - user_id = sha256(token)[0:16]，同一 token 永远映射同一记忆库
 * - token AES-256-GCM 加密落库，日志脱敏
 */
import jwt from 'jsonwebtoken';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { decryptToken, deriveUserId, encryptToken, tokenFingerprint } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyToken } from './mcp-verify.js';
const log = createLogger('auth');
/** 登录：验证 token → 派生 user_id → 加密落库 → 签发 JWT */
export async function login(token) {
    const cfg = loadConfig();
    await verifyToken(token);
    const userId = deriveUserId(token);
    const fp = tokenFingerprint(token);
    const enc = encryptToken(token, cfg.tokenEncKey);
    const now = Date.now();
    const db = getDb();
    const existing = db
        .prepare('SELECT * FROM users WHERE user_id = ?')
        .get(userId);
    let isNew = false;
    if (existing) {
        db.prepare('UPDATE users SET token_enc = ?, token_fp = ?, updated_at = ? WHERE user_id = ?').run(enc, fp, now, userId);
        if (existing.token_fp && existing.token_fp !== fp) {
            log.info(`用户 ${userId} Token 已轮换（指纹 ${existing.token_fp} → ${fp}）`);
        }
    }
    else {
        db.prepare(`INSERT INTO users (user_id, token_enc, token_fp, auto_confirm, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`).run(userId, enc, fp, now, now);
        isNew = true;
    }
    const jwtToken = jwt.sign({ sub: userId }, cfg.jwtSecret, {
        expiresIn: cfg.jwtTtlSeconds,
        algorithm: 'HS256',
    });
    const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    const needOnboarding = !row.nickname;
    log.info(`登录成功 user=${userId} isNew=${isNew} onboarding=${needOnboarding}`);
    return { userId, isNew, needOnboarding, jwt: jwtToken };
}
export function verifyJwt(token) {
    const cfg = loadConfig();
    let payload;
    try {
        payload = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] });
    }
    catch {
        throw new UnauthorizedError('登录已过期，请重新登录');
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || !/^[0-9a-f]{16}$/.test(sub)) {
        throw new UnauthorizedError('登录已过期，请重新登录');
    }
    return sub;
}
export function getUser(userId) {
    return getDb().prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}
/** 取解密后的 token（调用 MCP 用），明文只在内存 */
export function getDecryptedToken(userId) {
    const row = getUser(userId);
    if (!row)
        throw new UnauthorizedError('账号不存在，请重新登录');
    const cfg = loadConfig();
    try {
        return decryptToken(row.token_enc, cfg.tokenEncKey);
    }
    catch (err) {
        log.error(`Token 解密失败 user=${userId}：${err.message}`);
        throw new UnauthorizedError('授权信息损坏，请重新粘贴 Token');
    }
}
export function toProfile(row) {
    let taboo = [];
    if (row.taboo) {
        try {
            const v = JSON.parse(row.taboo);
            if (Array.isArray(v))
                taboo = v.filter((x) => typeof x === 'string');
        }
        catch {
            /* ignore */
        }
    }
    const p = { taboo };
    if (row.nickname)
        p.nickname = row.nickname;
    if (row.birthday)
        p.birthday = row.birthday;
    if (row.star_sign)
        p.starSign = row.star_sign;
    return p;
}
/** 解绑：删除该用户全部数据（不可恢复） */
export function unbind(userId) {
    const db = getDb();
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM mood_diary WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM chats WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    log.warn(`解绑并删除全部数据 user=${userId}`);
}
export function setAutoConfirm(userId, value) {
    getDb()
        .prepare('UPDATE users SET auto_confirm = ?, updated_at = ? WHERE user_id = ?')
        .run(value ? 1 : 0, Date.now(), userId);
}
//# sourceMappingURL=auth.service.js.map