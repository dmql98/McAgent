/**
 * MCP 网关
 *
 * 四件事：
 * 1. 每用户 token 注入（解密后仅在内存）
 * 2. 连接池复用（按 userId，token 换了要重建）
 * 3. 限流保护（只读走 TTL 缓存 + 每用户令牌桶）
 * 4. 错误语义化（401/429/5xx → 三种业务异常）
 *
 * 安全红线：明文 token 不进日志、不进错误 message、不进返回值。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { AuthError, RateLimitError, McpDownError, mapMcpError, looksLikeAuthError } from '../lib/errors.js';
import { tokenFingerprint } from '../lib/crypto.js';
import { getDecryptedToken, getUser } from '../services/auth.service.js';
import { TtlCache } from './cache.js';
import { decodeToolResult } from './toon.js';
const log = createLogger('mcp');
/* ------------------------------------------------------------------ */
/* 配置                                                              */
/* ------------------------------------------------------------------ */
/**
 * 只读白名单 + 各自 TTL。不在这里的一律不缓存（安全默认）。
 *
 * 划分依据：
 * - 相对静态（菜单/门店/营养/商城）→ 长 TTL，省额度
 * - 因人因时变化（账户/奖励/活动/地址）→ 短 TTL（分钟级），兼顾"不烧额度"与"别太旧"
 * - 订单状态、价格试算 → 永不缓存（错价比慢更糟）
 */
export const READONLY_CACHE_TTL = {
    'now-time-info': 30_000,
    'query-meals': 10 * 60_000,
    'query-meal-detail': 10 * 60_000,
    'query-nearby-stores': 5 * 60_000,
    'delivery-query-stores': 5 * 60_000,
    'delivery-query-addresses': 5 * 60_000,
    'query-store-coupons': 5 * 60_000,
    'list-nutrition-foods': 24 * 60 * 60_000,
    'query-my-account': 60_000,
    'query-my-coupons': 60_000,
    'available-coupons': 5 * 60_000,
    'query-my-prizes': 2 * 60_000,
    'query-lottery-info': 2 * 60_000,
    'mall-points-products': 10 * 60_000,
    'mall-product-detail': 10 * 60_000,
    'mall-order-list': 2 * 60_000,
    'mall-order-detail': 2 * 60_000,
    'order-list': 2 * 60_000,
    'campaign-calendar': 30 * 60_000,
    'query-party-city': 30 * 60_000,
    'query-party-store': 30 * 60_000,
    'query-party-store-date': 10 * 60_000,
    'query-party-store-session': 10 * 60_000,
    'query-promotions': 10 * 60_000,
    'query-meal-assistance': 10 * 60_000,
    'query-survey-coupon': 10 * 60_000,
};
/**
 * 写操作：永不缓存，且必须由调用方显式"确认"后才能触达。
 *
 * 早期只列了三个，实测服务端有 35 个工具，其中 7 个会改用户账号状态。
 * 漏一个是真实资损/误操作风险，所以这里集中列全（catalog 里 readonly 也据此生成）。
 */
export const WRITE_TOOLS = new Set([
    'create-order',
    'cancel-order',
    'auto-bind-coupons',
    'draw-lottery',
    'mall-create-order',
    'party-order-create',
    'delivery-create-address',
]);
const PER_USER_LIMIT = 20; // req/min
const GLOBAL_LIMIT = 550; // req/min（平台 600，留 50 安全边际）
const WINDOW_MS = 60_000;
const POOL_IDLE_MS = 10 * 60_000;
const POOL_MAX = 50;
const pool = new Map();
const cache = new TtlCache({ maxSize: 500, defaultTtlMs: 5 * 60_000 });
/** 令牌桶（滑动窗口） */
const userHits = new Map();
let globalHits = [];
function pruneWindow(arr, now) {
    return arr.filter((t) => t > now - WINDOW_MS);
}
function checkRateLimit(userId) {
    const now = Date.now();
    globalHits = pruneWindow(globalHits, now);
    if (globalHits.length >= GLOBAL_LIMIT) {
        throw new RateLimitError('服务整体请求量到上限了，稍等一下');
    }
    const hits = pruneWindow(userHits.get(userId) ?? [], now);
    if (hits.length >= PER_USER_LIMIT) {
        userHits.set(userId, hits);
        throw new RateLimitError('你问得有点快，缓一分钟再问我');
    }
    hits.push(now);
    userHits.set(userId, hits);
    globalHits.push(now);
}
export function rateLimitStats() {
    const now = Date.now();
    return { users: userHits.size, global: pruneWindow(globalHits, now).length };
}
export function resetGatewayForTest() {
    for (const [, p] of pool) {
        void p.client.close().catch(() => undefined);
    }
    pool.clear();
    cache.clear();
    userHits.clear();
    globalHits = [];
}
/* ------------------------------------------------------------------ */
/* 连接管理                                                          */
/* ------------------------------------------------------------------ */
async function getPooledClient(userId) {
    const cfg = loadConfig();
    const token = getDecryptedToken(userId); // 明文只在内存
    const fp = tokenFingerprint(token);
    const existing = pool.get(userId);
    if (existing) {
        // token 换了 → 销毁重建
        if (existing.fingerprint !== fp) {
            log.info(`用户 ${userId} Token 指纹变化，重建连接`);
            await closePooled(userId);
        }
        else {
            existing.lastUsed = Date.now();
            return existing;
        }
    }
    // LRU 淘汰
    if (pool.size >= POOL_MAX) {
        let lruKey = null;
        let lruAt = Infinity;
        for (const [k, v] of pool) {
            if (v.lastUsed < lruAt) {
                lruAt = v.lastUsed;
                lruKey = k;
            }
        }
        if (lruKey)
            await closePooled(lruKey);
    }
    const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpEndpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'mcd-soulmate', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const entry = { client, transport, lastUsed: Date.now(), fingerprint: fp };
    pool.set(userId, entry);
    log.debug(`连接池新建 user=${userId} size=${pool.size}`);
    return entry;
}
async function closePooled(userId) {
    const e = pool.get(userId);
    if (!e)
        return;
    pool.delete(userId);
    try {
        await e.client.close();
    }
    catch {
        /* ignore */
    }
}
function cacheKey(toolName, args) {
    const argsKey = Object.keys(args)
        .sort()
        .map((k) => `${k}=${JSON.stringify(args[k])}`)
        .join('&');
    return `${toolName}?${argsKey}`;
}
let lastMeta = { cached: false, costMs: 0, tool: '' };
export function lastCallMeta() {
    return lastMeta;
}
/**
 * 统一工具调用入口（架构 §8 规定的形状）
 */
export async function callTool(userId, toolName, args = {}, opts = {}) {
    const env = await callToolEnvelope(userId, toolName, args, opts);
    return env.data;
}
/**
 * 带信封信息的调用（供「工具台 / 数据来源角标」用）。
 *
 * 为什么要单独一个函数：`lastCallMeta()` 是模块级全局，并发时会互相覆盖。
 * 需要在响应里精确标注「这次是不是缓存、花了多久」的调用必须拿到自己的那份。
 */
export async function callToolEnvelope(userId, toolName, args = {}, opts = {}) {
    const cfg = loadConfig();
    const started = Date.now();
    const isWrite = WRITE_TOOLS.has(toolName);
    const defaultTtl = isWrite ? null : (READONLY_CACHE_TTL[toolName] ?? null);
    const ttl = opts.cacheTtl === undefined ? defaultTtl : opts.cacheTtl;
    const ck = cacheKey(toolName, args);
    /* --- 缓存命中 --- */
    if (ttl !== null) {
        const hit = cache.get(ck);
        if (hit !== undefined) {
            const meta = { cached: true, costMs: Date.now() - started, tool: toolName };
            lastMeta = meta;
            if (cfg.debugMcp) {
                log.debug(`user=${userId.slice(0, 4)}… tool=${toolName} cached=true cost=${meta.costMs}ms`);
            }
            return { data: hit, ...meta, rawText: undefined };
        }
    }
    /* --- 限流检查（写操作也限） --- */
    try {
        checkRateLimit(userId);
    }
    catch (err) {
        // 限流时若有缓存，用缓存顶上
        if (ttl !== null) {
            const stale = cache.get(ck);
            if (stale !== undefined) {
                log.warn(`限流降级：用缓存顶替 tool=${toolName} user=${userId.slice(0, 4)}…`);
                return { data: stale, cached: true, costMs: Date.now() - started, tool: toolName, rawText: undefined };
            }
        }
        throw err;
    }
    /* --- 真实调用 --- */
    const timeoutMs = opts.timeoutMs ?? (isWrite ? 30_000 : 15_000);
    let raw;
    try {
        const entry = await getPooledClient(userId);
        raw = await withTimeout(entry.client.callTool({ name: toolName, arguments: args }), timeoutMs, toolName);
        entry.lastUsed = Date.now();
    }
    catch (err) {
        const mapped = mapMcpError(err);
        if (mapped instanceof AuthError) {
            log.warn(`MCP 鉴权失败，销毁连接 user=${userId.slice(0, 4)}…`);
            await closePooled(userId);
        }
        if (mapped instanceof McpDownError) {
            // 连接层错误也可能导致连接失效，一并清理
            await closePooled(userId).catch(() => undefined);
        }
        lastMeta = { cached: false, costMs: Date.now() - started, tool: toolName };
        if (cfg.debugMcp) {
            log.warn(`tool=${toolName} 失败 ${lastMeta.costMs}ms: ${mapped.code}`);
        }
        throw mapped;
    }
    /* --- 解码 --- */
    const rawText = extractText(raw);
    const decoded = decodeToolResult(raw);
    // MCP 层业务错误：isError=true
    const asResult = raw;
    if (asResult?.isError) {
        const text = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
        if (looksLikeAuthError(text))
            throw new AuthError();
        if (/429|rate.?limit|too many/i.test(text))
            throw new RateLimitError();
        log.warn(`MCP 工具返回 isError tool=${toolName}: ${text.slice(0, 200)}`);
        throw new McpDownError(`麦当劳返回了一个错误：${text.slice(0, 120)}`);
    }
    /* --- 业务失败判定 ---
     * 麦当劳外层信封是 {success, code, message, datetime, traceId, data}。
     * 参数缺失/参数非法时 HTTP 依然 200、isError 也不为 true，只是 success=false。
     * 这种结果绝不能进缓存：否则一次调用出错，接下来整个 TTL 周期（如
     * query-party-city 是 30 分钟）都会拿着「缺少参数」当数据发出去。
     * 这正是「服务端返回了内容，但没能解析出条目」的真实来源。
     */
    const bizFailed = isBizFailure(decoded);
    /* --- 写缓存（只写成功的） --- */
    if (ttl !== null && !bizFailed)
        cache.set(ck, decoded, ttl);
    lastMeta = { cached: false, costMs: Date.now() - started, tool: toolName };
    if (cfg.debugMcp) {
        log.debug(`user=${userId.slice(0, 4)}… tool=${toolName} cached=false cost=${lastMeta.costMs}ms` +
            (bizFailed ? '（业务失败，未写缓存）' : ''));
    }
    return { data: decoded, ...lastMeta, rawText };
}
/**
 * 判断响应是不是业务失败。
 * 只看明确的失败信号，拿不准就当作成功 —— 宁可缓存一个可疑结果，
 * 也不要因为过严的判定让所有工具都失去缓存。
 */
export function isBizFailure(decoded) {
    if (!decoded || typeof decoded !== 'object')
        return false;
    const o = decoded;
    if (o.success === false)
        return true;
    // 有些工具用 code 表达业务状态：0/200 是成功，其它且带了 message 的算失败
    const code = o.code;
    if (typeof code === 'number' && code !== 0 && code !== 200) {
        if (typeof o.message === 'string' && o.message.length > 0)
            return true;
    }
    return false;
}
/** 从 MCP 返回里取出原始文本（工具台要能看见"服务端到底说了什么"） */
export function extractText(raw) {
    if (typeof raw === 'string')
        return raw;
    if (!raw || typeof raw !== 'object')
        return undefined;
    const content = raw.content;
    if (!Array.isArray(content))
        return undefined;
    const texts = content
        .filter((c) => Boolean(c) && typeof c === 'object')
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text);
    return texts.length ? texts.join('\n') : undefined;
}
function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            reject(new McpDownError(`${label} 超时了（${ms}ms）`));
        }, ms);
        p.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (e) => {
            clearTimeout(t);
            reject(e);
        });
    });
}
/* ------------------------------------------------------------------ */
/* 健康检查与关闭                                                    */
/* ------------------------------------------------------------------ */
export async function pingMcp() {
    const cfg = loadConfig();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
        const res = await fetch(cfg.mcpEndpoint, {
            method: 'HEAD',
            signal: ctrl.signal,
        }).catch(() => fetch(cfg.mcpEndpoint, { signal: ctrl.signal }));
        return res.status < 500;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(t);
    }
}
/** 空闲连接清理 */
const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pool) {
        if (now - v.lastUsed > POOL_IDLE_MS) {
            log.debug(`空闲断开 user=${k.slice(0, 4)}…`);
            void closePooled(k);
        }
    }
}, 60_000);
idleTimer.unref?.();
export async function shutdownGateway() {
    clearInterval(idleTimer);
    const ids = [...pool.keys()];
    await Promise.all(ids.map((id) => closePooled(id)));
    cache.dispose();
    log.info('MCP 网关已关闭');
}
export function gatewayStats() {
    return {
        poolSize: pool.size,
        cache: cache.stats(),
        rate: rateLimitStats(),
    };
}
/** 供 M4 检查用户是否存在（避免无谓解密） */
export function hasUser(userId) {
    return Boolean(getUser(userId));
}
//# sourceMappingURL=gateway.js.map