/**
 * 资产服务：卡包券 / 可领券 / 门店券 / 积分
 *
 * 实测（docs/mcp-live-report.md）：
 *   · query-my-coupons     → markdown 券面文案（`## 券名` + 优惠/有效期字段 + img 标签）
 *   · available-coupons    → markdown 列表（优惠券标题 / 状态 / 图片）
 *   · query-store-coupons  → 结构化 JSON（data[]: title/couponId/couponCode/tradeDateTime/products）
 *   · query-my-account     → 结构化 JSON（data.availablePoint 等，值是字符串）
 *
 * 注意：上面这段注释里不要出现「星号+斜杠」的连续写法，
 * 否则会把块注释提前闭合，整个文件编译不过（踩过一次）。
 *
 * 所以这里必须自带 markdown 解析器。解析不出东西就返回空数组，
 * **绝不凭空造券** —— 假券会把用户带到一个核销不了的页面，比空列表糟糕得多。
 */
import { createLogger } from '../lib/logger.js';
import { callTool } from '../mcp/gateway.js';
import { pickArray, pickString } from '../mcp/toon.js';
import { resolveStore } from './store.service.js';
const log = createLogger('assets');
/* ------------------------------------------------------------------ */
/* markdown 解析                                                      */
/* ------------------------------------------------------------------ */
/** 取 `- **优惠**: ¥22.9 (用券价格)` 这类键值 */
function field(body, key) {
    const m = body.match(new RegExp(`\\*\\*${key}\\*\\*\\s*[:：]\\s*(.+)`));
    return m?.[1]?.trim();
}
/** 取第一个 <img> 的 src */
function firstImage(text) {
    const m = text.match(/<img[^>]*\ssrc="([^"]+)"/);
    return m?.[1];
}
/** 从「¥22.9 (用券价格)」里拆出金额与说明 */
function splitPrice(raw) {
    const m = raw.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    const noteM = raw.match(/[(（]([^)）]+)[)）]/);
    const out = {};
    if (m?.[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n))
            out.price = n;
    }
    if (noteM?.[1])
        out.note = noteM[1].trim();
    return out;
}
function splitTags(raw) {
    return raw
        .split(/[、,，·/|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4);
}
/** 按 markdown 标题切块，返回 [{title, body}] */
function splitBlocks(text, heading) {
    const matches = [...text.matchAll(heading)];
    const out = [];
    for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        const start = (cur.index ?? 0) + cur[0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
        out.push({ title: (cur[1] ?? '').trim(), body: text.slice(start, end) });
    }
    return out;
}
/**
 * 卡包券（query-my-coupons）
 *
 * 实测样例：
 *   ## 麦辣鸡腿堡三件套
 *   - **优惠**: ¥22.9 (用券价格)
 *   - **有效期**: 2026-10-23 00:00-2026-11-23 23:59 10:30-23:59
 *   - **领取时间**: 今日收到
 *   - **标签**: 到店专用
 *   <img src="..." alt="麦辣鸡腿堡三件套" ...>
 */
export function parseMyCoupons(text) {
    if (!text || typeof text !== 'string')
        return [];
    const blocks = splitBlocks(text, /^##\s+(.+?)\s*$/gm);
    const out = [];
    for (const [i, b] of blocks.entries()) {
        if (!b.title || /优惠券列表|列表$/.test(b.title))
            continue;
        if (!/<img|优惠|有效期/.test(b.body))
            continue;
        const item = { id: `card-${i}-${b.title}`, title: b.title, tags: [] };
        const priceRaw = field(b.body, '优惠');
        if (priceRaw) {
            const p = splitPrice(priceRaw);
            if (p.price !== undefined)
                item.price = p.price;
            if (p.note)
                item.priceNote = p.note;
            else
                item.priceNote = priceRaw;
        }
        const validity = field(b.body, '有效期');
        if (validity)
            item.validity = validity;
        const received = field(b.body, '领取时间');
        if (received)
            item.receivedAt = received;
        const tags = field(b.body, '标签');
        if (tags)
            item.tags = splitTags(tags);
        const img = firstImage(b.body);
        if (img)
            item.image = img;
        else {
            const alt = b.body.match(/alt="([^"]+)"/);
            if (alt)
                item.title = item.title || alt[1] || item.title;
        }
        out.push(item);
    }
    return out;
}
/**
 * 可领券（available-coupons）
 *
 * 实测样例：
 *   ### 麦麦省优惠券列表：
 *   - 优惠券标题：免费脆薯饼 \
 *     状态：可领取 \
 *     优惠券图片：\
 *       <img src="..." alt="免费脆薯饼" height="auto" width="300">
 */
export function parseAvailableCoupons(text) {
    if (!text || typeof text !== 'string')
        return [];
    const blocks = splitBlocks(text, /^-\s*优惠券标题\s*[:：]\s*(.+)$/gm);
    const out = [];
    for (const [i, b] of blocks.entries()) {
        const title = b.title.replace(/\\\s*$/, '').trim();
        if (!title)
            continue;
        const item = { id: `claim-${i}-${title}`, title, tags: [] };
        const status = b.body.match(/状态\s*[:：]\s*([^\n\\|]+)/);
        if (status?.[1])
            item.status = status[1].trim();
        const tags = b.body.match(/标签\s*[:：]\s*([^\n\\|]+)/);
        if (tags?.[1])
            item.tags = splitTags(tags[1]);
        const img = firstImage(b.body);
        if (img)
            item.image = img;
        out.push(item);
    }
    return out;
}
/** 门店券（query-store-coupons，结构化 JSON） */
export function parseStoreCoupons(raw) {
    const arr = pickArray(raw, ['data', 'list', 'coupons']);
    const out = [];
    for (const [i, r] of arr.entries()) {
        if (!r || typeof r !== 'object')
            continue;
        const o = r;
        const title = pickString(o, ['title', 'couponName', 'name']);
        if (!title)
            continue;
        const products = Array.isArray(o.products)
            ? o.products
                .map((p) => pickString(p, ['productName', 'name']))
                .filter((x) => Boolean(x))
            : [];
        const item = {
            id: pickString(o, ['couponId', 'id']) ?? `store-${i}-${title}`,
            title,
            tags: [],
        };
        const validity = pickString(o, ['tradeDateTime', 'validity', 'expireTime']);
        if (validity)
            item.validity = validity;
        const code = pickString(o, ['couponCode']);
        if (code)
            item.code = code;
        if (products.length > 0) {
            item.products = products;
            item.tags = [products.length > 1 ? `适用 ${products.length} 款` : products[0]];
        }
        out.push(item);
    }
    return out;
}
/** 积分账户（query-my-account，值是字符串） */
export function parsePoints(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const root = raw;
    const body = (root.data && typeof root.data === 'object' ? root.data : root);
    const num = (keys) => {
        for (const k of keys) {
            const v = body[k];
            if (typeof v === 'number' && Number.isFinite(v))
                return v;
            if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))
                return parseFloat(v);
        }
        return 0;
    };
    const available = num(['availablePoint', 'availablePoints', 'point', 'points']);
    const currency = pickString(body, ['currency']) ?? '积分';
    // 一个字段都没有 → 不是积分响应，别硬编 0
    if (!('availablePoint' in body) && !('availablePoints' in body) && !('point' in body))
        return null;
    return {
        available,
        // ⚠️ 服务端拼写是 Mouth 不是 Month
        expiringThisMonth: num(['currentMouthExpirePoint', 'currentMonthExpirePoint']),
        accumulated: num(['accumulativePoint', 'accumulatedPoint']),
        used: num(['usedPoint']),
        expired: num(['expiredPoint']),
        currency,
    };
}
/* ------------------------------------------------------------------ */
/* 对外：资产总览                                                     */
/* ------------------------------------------------------------------ */
async function settle(p, label) {
    try {
        return await p;
    }
    catch (err) {
        // 401 必须往上抛：前端要能引导重新粘贴 Token，不能当成"没有券"
        if (err?.code === 'TOKEN_INVALID')
            throw err;
        log.warn(`${label} 失败（已降级为空）：${err.message}`);
        return null;
    }
}
/** 卡包 + 可领券 + 积分，一次请求给前端 */
export async function getAssets(userId) {
    const [cardRaw, claimableRaw, pointsRaw] = await Promise.all([
        settle(callTool(userId, 'query-my-coupons', { page: '1', pageSize: '200' }, { cacheTtl: null }), '卡包券'),
        settle(callTool(userId, 'available-coupons', {}, { cacheTtl: null }), '可领券'),
        settle(callTool(userId, 'query-my-account', {}, { cacheTtl: null }), '积分'),
    ]);
    const textOf = (v) => (typeof v === 'string' ? v : '');
    return {
        points: parsePoints(pointsRaw),
        coupons: {
            card: parseMyCoupons(textOf(cardRaw)),
            claimable: parseAvailableCoupons(textOf(claimableRaw)),
        },
    };
}
/* ------------------------------------------------------------------ */
/* 对外：门店券                                                       */
/* ------------------------------------------------------------------ */
/**
 * 门店券需要「先定门店」。
 * 门店解析统一走 store.service，保证和菜单页看到的是同一家店。
 * 没有城市 → 返回 NEED_LOCATION，前端引导授权定位（不当成错误弹红）。
 */
export async function getStoreCoupons(userId) {
    let resolved;
    try {
        resolved = await resolveStore(userId);
    }
    catch (err) {
        const code = err?.code;
        if (code === 'TOKEN_INVALID' || code === 'RATE_LIMITED')
            throw err;
        return {
            coupons: [],
            store: null,
            reason: code === 'NEED_LOCATION' ? 'NEED_LOCATION' : 'MCP_DOWN',
            message: err.message,
        };
    }
    const storeRef = { storeCode: resolved.store.storeCode, name: resolved.store.name };
    try {
        const raw = await callTool(userId, 'query-store-coupons', {
            storeCode: resolved.store.storeCode,
            orderType: 1,
            beType: 1,
        });
        return { coupons: parseStoreCoupons(raw), store: storeRef };
    }
    catch (err) {
        const code = err?.code;
        if (code === 'TOKEN_INVALID' || code === 'RATE_LIMITED')
            throw err;
        log.warn(`门店券查询失败：${err.message}`);
        return { coupons: [], store: storeRef, reason: 'MCP_DOWN' };
    }
}
/* ------------------------------------------------------------------ */
/* 对外：一键领券（写操作）                                           */
/* ------------------------------------------------------------------ */
/**
 * 一键领取麦麦省所有可领券。
 *
 * 这是**写操作**：领了就在用户账号里生效。
 * 所以前端必须先弹确认（PRD §7 领券确认制），不接受静默调用。
 */
export async function claimCoupons(userId) {
    try {
        await callTool(userId, 'auto-bind-coupons', {}, { cacheTtl: null });
        return { claimed: true, message: '能领的都领到了，去卡包看看' };
    }
    catch (err) {
        if (err?.code === 'TOKEN_INVALID')
            throw err;
        const msg = err.message;
        log.warn(`一键领券失败：${msg}`);
        return { claimed: false, message: msg || '领券没成功，稍后再试' };
    }
}
//# sourceMappingURL=assets.service.js.map