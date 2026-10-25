/**
 * 购物车意图解析
 *
 * 产品变化后，「对话」有两种完全不同的语义，必须先分清再决定走哪条路：
 *
 *   A. 「两个人 100 块，不辣」  → **重新组一单**，替换购物车
 *   B. 「薯条删掉」「可乐来两杯」「再加个苹果片」 → **改现有购物车**，不重新选品
 *
 * 如果 B 也走选品，用户会看到：明明只想删一份薯条，结果整份菜单被换掉。
 * 这是最让人火大的一种"聪明"。所以这里单独做一层识别，命中就直接改车。
 *
 * 只做规则、不调 LLM：这类指令说法很固定（删/加/换成/来N个），
 * 规则足够准，而且**不会误判**——误判的代价是把用户的一单毁掉。
 */
/** 中文数字 → 阿拉伯数字（只覆盖点餐里会出现的范围） */
const CN_NUM = {
    零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
export function cnToNum(s) {
    if (/^\d+$/.test(s))
        return Number(s);
    if (s.length === 1)
        return CN_NUM[s] ?? null;
    // 十一 / 十二 / 二十
    if (s.startsWith('十')) {
        const rest = s.slice(1);
        return rest ? (CN_NUM['十'] ?? 10) + (CN_NUM[rest] ?? 0) : 10;
    }
    if (s.endsWith('十'))
        return (CN_NUM[s[0]] ?? 0) * 10;
    const m = /^(.)十(.)$/.exec(s);
    if (m)
        return (CN_NUM[m[1]] ?? 0) * 10 + (CN_NUM[m[2]] ?? 0);
    return null;
}
const QTY_PAT = '([0-9]+|[一二两三四五六七八九十]+)';
/**
 * 从指令里抠出数量。默认 1。
 * 「来两杯可乐」「可乐 3 个」「加一份薯条」都要能取到。
 */
export function extractQty(text) {
    const withN = new RegExp(`(?:来|要|加|再来|改|换成?)\\s*${QTY_PAT}\\s*(?:杯|个|份|块|只|根|盒|张)?`).exec(text);
    if (withN) {
        const n = cnToNum(withN[1]);
        if (n && n > 0)
            return Math.min(99, n);
    }
    const beforeUnit = new RegExp(`${QTY_PAT}\\s*(?:杯|个|份|块|只|根|盒|张)`).exec(text);
    if (beforeUnit) {
        const n = cnToNum(beforeUnit[1]);
        if (n && n > 0)
            return Math.min(99, n);
    }
    return 1;
}
/**
 * 去掉「删掉」「来两杯」这类动词，剩下的才是商品名。
 *
 * ⚠️ 两种说法必须都覆盖，否则商品名里会残留动词：
 *   「薯条删了」→ 动词在**后面**
 *   「把薯条删了」→ 动词在后、还多一个「把」
 * 早期只处理了「删掉」没处理「删了」，于是「把薯条删了」被整句当成商品名，
 * 用户看到「车里没有『把薯条删了』」这种回复。
 */
function stripVerbs(text) {
    return (text
        // 1. 客气话
        .replace(/^(帮我|给我|请|麻烦)+/g, '')
        // 2. 「把/将 + 宾语」的处置式，宾语句首的「把」不是商品名的一部分
        .replace(/^[把将]/g, '')
        // 3. 动词（可能出现在句中，也可能在句尾）
        .replace(/(再?来|再?要|再?加|添加|加个|加一?份|换成?|改成?|删除|删掉|删去|删了|去掉|拿掉|减掉|别要|不要|取消)/g, '')
        // 4. 数量 + 量词
        .replace(new RegExp(`${QTY_PAT}\\s*(杯|个|份|块|只|根|盒|张)`, 'g'), '')
        // 5. 标点
        .replace(/[，。,.！!？?、]/g, '')
        // 6. 句尾语气词（剥离后剩下的「了/吧/呢」不属于菜名）
        .replace(/[了吧呢啊呀哈]+$/g, '')
        .replace(/\s+/g, '')
        .trim());
}
/** 明显的「删」 */
const DEL_PAT = /(删除|删掉|删了|去掉|不要|取消|拿掉|减掉|别要|去一个|去一份)/;
/**
 * 明显的「加」。
 *
 * ⚠️ 必须覆盖「来两杯」「要三个」这种「动词+数量+单位」，
 * 否则会漏到下面的「改数量」分支，被当成"把某物改成 N 份"。
 * 早期就是漏了这条，用户说「可乐来两杯」被理解成 setQty。
 */
const ADD_PAT = /(再加|再点|再来|加个|加一|添加|来[0-9一二两三四五六七八九十]+[杯个份块只根盒张]?|要[0-9一二两三四五六七八九十]+[杯个份块只根盒张]?|来一?个|来一?份|再要|多要|^加)/;
/**
 * 「改数量」必须带**明确动词**：改成/换成/改到。
 *
 * ⚠️ 不能光看"数字+量词"就判 setQty：
 * 「两个人吃 100 块」里的「两」会被当成数量，
 * 于是正常点餐请求被误判成"把某物改成 2 份"，整单一换全乱。
 */
const SETQTY_PAT = /(改成|改成?|换成?\s*[0-9一二两三四五六七八九十]|改到|调成|变成)\s*([0-9]+|[一二两三四五六七八九十]+)/;
/** 清空 */
const CLEAR_PAT = /(全部清空|都删了|清空购物车|全都不要|重新来一单|都不要了)/;
/** 「换成 X」 */
const SWAP_PAT = /把?\s*([^\s，。]+?)\s*(?:换成|替换成|改成)\s*([^\s，。]+)/;
/**
 * 解析一句话是不是在改购物车。
 *
 * 保守原则：**认不出来就当 none**，走正常选品。
 * 误判成「改车」会毁掉用户正在配的一单，比漏判严重得多。
 */
export function parseCartIntent(raw) {
    const text = (raw ?? '').trim().replace(/\s+/g, '');
    if (!text || text.length > 40)
        return { kind: 'none' };
    /* --- 清空 --- */
    if (CLEAR_PAT.test(text))
        return { kind: 'clear' };
    /* --- 换成 X --- */
    const swap = SWAP_PAT.exec(text);
    if (swap && swap[1] && swap[2]) {
        const from = stripVerbs(swap[1]).replace(/(这?个|这?份)$/, '');
        const to = stripVerbs(swap[2]);
        if (from && to)
            return { kind: 'swap', from, to };
    }
    /* --- 删 --- */
    if (DEL_PAT.test(text)) {
        const q = stripVerbs(text);
        if (q)
            return { kind: 'remove', query: q };
        return { kind: 'none' };
    }
    /* --- 改数量（必须有明确动词）--- */
    const isAdd = ADD_PAT.test(text);
    if (!isAdd && SETQTY_PAT.test(text)) {
        const q = stripVerbs(text);
        if (q)
            return { kind: 'setQty', query: q, qty: extractQty(text) };
    }
    /* --- 加 --- */
    if (isAdd) {
        const q = stripVerbs(text);
        if (q)
            return { kind: 'add', query: q, qty: extractQty(text) };
    }
    return { kind: 'none' };
}
/**
 * 在购物车里按名字找一项。
 *
 * 用「包含」而不是「相等」：用户说「薯条」，车里叫「薯条（中）」；
 * 说「可乐」，车里叫「无糖可口可乐」。用户不会背全名。
 *
 * 多条命中时取最短名字的那条（通常是最通用/最便宜的那款），
 * 保证同样说法每次命中同一项 —— 确定性比"更聪明"重要。
 */
export function findItemByName(items, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return null;
    const exact = items.find((it) => it.name.toLowerCase() === q);
    if (exact)
        return exact;
    const hits = items.filter((it) => {
        const n = it.name.toLowerCase();
        return n.includes(q) || q.includes(n);
    });
    if (hits.length === 0)
        return null;
    if (hits.length === 1)
        return hits[0];
    return hits.sort((a, b) => a.name.length - b.name.length)[0];
}
//# sourceMappingURL=cart-intent.service.js.map