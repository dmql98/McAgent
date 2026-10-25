/**
 * 定位服务：坐标 → 城市 + 商圈关键词
 *
 * 为什么需要这一步（关键约束）：
 * 麦当劳 `query-nearby-stores` **不接受经纬度**，只接受
 *   { city, keyword, searchType: 2 }
 * 所以浏览器定位拿到的 lat/lng 不能直接传给 MCP，
 * 必须先反查出「城市名」和「商圈/街道名」，才能查到用户身边的门店。
 *
 * 反查用 OpenStreetMap Nominatim：
 * - 免费、无需 API Key（评审现场不能依赖私有凭证）
 * - 支持 accept-language=zh-CN，直接返回中文地名
 * - 要求：必须带 User-Agent，且 ≤ 1 req/s（本项目定位是低频操作，天然满足）
 *
 * 失败不影响主流程：拿不到城市就退化成"让用户自己说城市"。
 */
import { createLogger } from '../lib/logger.js';
const log = createLogger('geo');
/** Nominatim 条款要求带 UA 标识；给个能联系到的名字 */
const USER_AGENT = 'mcd-soulmate/1.0 (WaytoAGI 1024 hackathon demo)';
const TIMEOUT_MS = 6000;
/**
 * 把中文城市名规范成 MCP 能接受的写法。
 *
 * MCP 实测接受「深圳市」「广州市」这类带「市」的写法；
 * 但用户/接口可能给「深圳」，统一补全，避免搜不到。
 */
export function normalizeCity(raw) {
    const s = (raw ?? '').trim();
    if (!s)
        return undefined;
    // 已经是「XX市」就不用动
    if (/[市盟州]$/.test(s))
        return s;
    // 自治州 / 地区 这类不补
    if (/自治|地区|新区|特区/.test(s))
        return s;
    return `${s}市`;
}
/**
 * 从 Nominatim 的 address 里挑出「城市」和「商圈」。
 *
 * 实测样例（深圳西丽）：
 *   address: {
 *     quarter: "丽雅社区",
 *     suburb: "西丽街道",
 *     city: "南山区",        ← ⚠️ 这个字段其实是"区"，不是"市"
 *     state: "广东省"
 *   }
 *   display_name: "丽雅社区, 西丽街道, 南山区, 深圳市, 广东省, 518000, 中国"
 *
 * 注意：Nominatim 把「区」放在 city 字段里，真正的「市」只在 display_name 里。
 * 所以城市必须从 display_name 解析，不能直接信 address.city。
 */
export function extractGeo(resp) {
    const addr = resp.address ?? {};
    const display = resp.display_name ?? '';
    // 从 display_name 里挑「XX市」—— 这是最可靠的城市来源
    let city;
    const parts = display.split(',').map((s) => s.trim());
    for (const p of parts) {
        if (/市$/.test(p) && !/区$/.test(p)) {
            city = p;
            break;
        }
    }
    // 兜底：address 里的 city/town/municipality（直辖市常在这几个字段）
    if (!city) {
        city = addr.city ?? addr.town ?? addr.municipality ?? addr.county;
    }
    // 商圈关键词：街道 > 片区 > 社区 > 路
    const district = addr.suburb ??
        addr.city_district ??
        addr.quarter ??
        addr.neighbourhood ??
        addr.town ??
        addr.road;
    const out = {};
    const normCity = normalizeCity(city);
    if (normCity)
        out.city = normCity;
    if (district)
        out.district = district;
    if (display)
        out.displayName = display;
    if (addr.state)
        out.province = addr.state;
    return out;
}
/**
 * 反查坐标对应的城市与商圈。
 * 任何异常都返回空对象（调用方降级让用户手填城市），绝不抛错阻塞对话。
 */
export async function reverseGeocode(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
        return {};
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180)
        return {};
    if (lat === 0 && lng === 0)
        return {}; // 浏览器定位失败的典型值
    const url = `https://nominatim.openstreetmap.org/reverse?format=json` +
        `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
        `&accept-language=zh-CN&zoom=16`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: ctrl.signal,
        });
        if (!res.ok) {
            log.warn(`反查失败 HTTP ${res.status}`);
            return {};
        }
        const json = (await res.json());
        const geo = extractGeo(json);
        log.debug(`反查 (${lat},${lng}) → city=${geo.city ?? '-'} district=${geo.district ?? '-'}`);
        return geo;
    }
    catch (err) {
        log.warn(`反查异常（已忽略）：${err.message}`);
        return {};
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=geo.service.js.map