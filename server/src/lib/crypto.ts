/**
 * 加密与哈希工具
 * - Token 加解密：AES-256-GCM，格式 base64(iv12 || tag16 || ciphertext)
 * - 身份派生：sha256(token) 前 16 位 hex
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/** user_id = sha256(token).slice(0,16)，一旦上线不可变更 */
export function deriveUserId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/** token 指纹，用于检测同一 userId 换了 token（连接池需要重建） */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
}

export function encryptToken(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY 必须是 32 字节');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY 必须是 32 字节');
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('密文长度非法');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 用于菜单快照校验 */
export function stableHash(obj: unknown): string {
  return createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex').slice(0, 32);
}

/** 键排序后的确定性 JSON，保证同一对象 hash 稳定 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
