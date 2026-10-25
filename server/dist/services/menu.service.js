/**
 * 菜单浏览服务 —— 「全部菜单」页的数据源
 *
 * 与对话流水线的区别：
 * - 对话是「一句话 → 一份搭配」，面向意图
 * - 这里是「全量菜单 → 你自己挑」，面向浏览
 *
 * 数据源（实测结构）：
 *   query-meals → data.categories[]{ name, meals[]{code, tags[]} }
 *                 data.meals{ code → {name, image, currentPrice, originalPrice,
 *                                     discountType, canWithOrder} }
 *   · 价格是字符串（"26.5"），amount 单位是元
 *   · canWithOrder=false 表示当前不可售（下架/售罄）
 *   · data.frequent = { code, tags }[]（常点，最多几条）
 */
import { createLogger } from '../lib/logger.js';
import { callTool } from '../mcp/gateway.js';
import { pickString } from '../mcp/toon.js';
import { resolveStore } from './store.service.js';
const log = createLogger('menu');
function num(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))
        return parseFloat(v);
    return undefined;
}
function str(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
/** 当前餐段（麦当劳的售卖时段划分） */
export function currentSlot(now = new Date()) {
    const h = now.getHours();
    if (h < 10)
        return '早餐';
    if (h < 14)
        return '午餐';
    if (h < 17)
        return '下午茶';
    if (h < 22)
        return '夜市';
    return '深夜';
}
/**
 * 把 query-meals 的返回解析成前端要的形状。
 * 解析不出来的分类直接跳过 —— 不猜、不补默认图、不编价格。
 */
export function adaptMenu(raw) {
    if (!raw || typeof raw !== 'object')
        return { categories: [], frequent: [] };
    const root = raw;
    const body = (root.data && typeof root.data === 'object' ? root.data : root);
    const meals = (body.meals && typeof body.meals === 'object' ? body.meals : {});
    /** code → 商品；map 里存的是「能卖的」 */
    const byCode = new Map();
    for (const [code, m] of Object.entries(meals)) {
        if (!m || typeof m !== 'object')
            continue;
        const name = str(m.name);
        if (!name)
            continue;
        const price = num(m.currentPrice) ?? num(m.price);
        // 没价格没法加购，直接丢（菜单里确实存在少量无价商品）
        if (price === undefined || price <= 0)
            continue;
        const p = {
            code,
            name,
            price,
            available: m.canWithOrder !== false,
            tags: [],
        };
        const image = str(m.image);
        if (image)
            p.image = image;
        const orig = num(m.originalPrice);
        if (orig !== undefined && orig > price)
            p.originalPrice = orig;
        const disc = str(m.discountType);
        if (disc)
            p.discountType = disc;
        byCode.set(code, p);
    }
    const categories = [];
    const cats = Array.isArray(body.categories) ? body.categories : [];
    for (const cat of cats) {
        if (!cat || typeof cat !== 'object')
            continue;
        const c = cat;
        const catName = str(c.name);
        if (!catName)
            continue;
        const list = Array.isArray(c.meals) ? c.meals : [];
        const products = [];
        for (const it of list) {
            if (!it || typeof it !== 'object')
                continue;
            const item = it;
            const code = str(item.code);
            if (!code)
                continue;
            const p = byCode.get(code);
            // 分类里列的 code 在 meals 里不存在（无价/下架）→ 跳过
            if (!p)
                continue;
            // 分类自带的 tags 是营销文案（「爆款」「韩式辣椒黄油风味」），很有价值
            const tags = Array.isArray(item.tags)
                ? item.tags.map((t) => str(t)).filter((t) => Boolean(t))
                : [];
            products.push(tags.length > 0 ? { ...p, tags } : p);
        }
        if (products.length > 0)
            categories.push({ name: catName, products });
    }
    /* --- 常点 --- */
    const frequent = [];
    const rawFreq = Array.isArray(body.frequent) ? body.frequent : [];
    for (const f of rawFreq) {
        if (!f || typeof f !== 'object')
            continue;
        const code = pickString(f, ['code']);
        if (!code)
            continue;
        const p = byCode.get(code);
        if (p)
            frequent.push(p);
    }
    return { categories, frequent };
}
/** 对外：全量菜单 */
export async function getMenu(userId) {
    const { store } = await resolveStore(userId);
    const raw = await callTool(userId, 'query-meals', {
        storeCode: store.storeCode,
        orderType: 1,
        beType: 1,
        ...(store.beCode ? { beCode: store.beCode } : {}),
    });
    const { categories, frequent } = adaptMenu(raw);
    if (categories.length === 0) {
        log.warn(`query-meals 未解析出分类 store=${store.storeCode}`);
    }
    const out = {
        store: { storeCode: store.storeCode, name: store.name },
        categories,
        frequent,
        slot: currentSlot(),
        updatedAt: Date.now(),
    };
    if (store.address)
        out.store.address = store.address;
    if (store.distance !== undefined)
        out.store.distance = store.distance;
    if (store.open !== undefined)
        out.store.open = store.open;
    return out;
}
//# sourceMappingURL=menu.service.js.map