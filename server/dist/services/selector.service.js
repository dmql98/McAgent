/* ------------------------------------------------------------------ */
/* 忌口过滤                                                          */
/* ------------------------------------------------------------------ */
/** 忌口词的同义词扩展，尽量不漏 */
const TABOO_SYNONYMS = {
    辣: ['辣', '香辣', '麻辣', '辣椒', '辣酱', 'jalapeno', 'spicy', 'hot sauce'],
    香菜: ['香菜', '芫荽', 'cilantro'],
    洋葱: ['洋葱', 'onion'],
    牛肉: ['牛肉', '牛', 'beef'],
    猪肉: ['猪肉', '猪', 'pork', '培根', 'bacon', '火腿', 'ham'],
    鸡肉: ['鸡肉', '鸡', 'chicken'],
    鱼: ['鱼', 'fish', '鳕', '三文鱼'],
    虾: ['虾', 'shrimp', 'prawn'],
    蟹: ['蟹', 'crab'],
    花生: ['花生', 'peanut'],
    坚果: ['坚果', 'nut', '杏仁', '核桃'],
    奶: ['奶', '乳', 'milk', 'cheese', '芝士', '奶油', '冰淇淋', '新地'],
    蛋: ['蛋', 'egg', '蛋黄'],
    麸质: ['麸质', 'gluten', '面包', '堡'],
    咖啡因: ['咖啡', 'coffee', 'coke', '可乐'],
    冰: ['冰', 'iced', '冷'],
};
function expandTaboo(taboo) {
    const out = new Set();
    for (const t of taboo) {
        out.add(t.toLowerCase());
        for (const s of TABOO_SYNONYMS[t] ?? [])
            out.add(s.toLowerCase());
    }
    return [...out];
}
function productText(p) {
    return [
        p.name ?? '',
        p.category ?? '',
        p.description ?? '',
        ...(p.ingredients ?? []),
        ...(p.combo ?? []),
    ]
        .join(' ')
        .toLowerCase();
}
/**
 * 口味标签 → 商品匹配。
 * 标签来自用户原话（"来点甜的""想吃辣的""清谈点"），必须真的能影响选品。
 *
 * ⚠️ 只匹配**商品名**，不要匹配分类字段。
 * 因为分类里有「小食甜品/其他」这种桶，一旦拿整段文本去匹「甜」，
 * 苹果片、玉米杯这种全都会被判成"甜食"，用户会觉得很奇怪。
 */
export function matchTasteTag(tag, name) {
    const t = tag.toLowerCase();
    const n = name.toLowerCase();
    if (n.includes(t))
        return true;
    const RULES = {
        甜: /甜|冰淇淋|新地|圆筒|派|糖|蛋糕|麦旋风|脆薯饼|松饼/,
        辣: /辣|龙焰|椒|辛/,
        冰: /冰|雪碧|可乐|冻|麦旋风/,
        热: /热|咖啡|红茶|可可|浓汤|奶铁|拿铁|美式/,
        咸: /咸|芝士|培根|薯条|鸡块|麦乐/,
        清淡: /沙拉|玉米|纯牛奶|苹果|红茶|纯悦|麦香鸡|麦香鱼|果汁/,
        健康: /沙拉|玉米|纯牛奶|苹果|纯悦|果汁/,
        牛肉: /牛|安格斯|巨无霸|吉士/,
        鸡肉: /鸡|板烧|麦乐|麦香鸡/,
        鱼: /鱼|鳕|麦香鱼/,
        咖啡: /咖啡|奶铁|拿铁|美式/,
        可乐: /可乐/,
        薯条: /薯条/,
        甜品: /甜|冰淇淋|新地|圆筒|派|麦旋风|脆薯饼/,
        大份: /四件套|三件套|套餐|双人|分享|巨无霸|安格斯/,
        小份: /迷你|小份/,
        减肥: /沙拉|玉米|纯悦|纯牛奶|苹果|红茶/,
    };
    const re = RULES[tag];
    return re ? re.test(n) : false;
}
/**
 * 「不宜」类标签：用户明确说减肥/清淡时，高热量主餐要降权。
 * 这不是硬过滤（不能什么都不给），只是排序上的强负分。
 */
function dislikeOf(tag, text) {
    const t = tag.toLowerCase();
    if (t === '减肥' || t === '减脂' || t === '控卡') {
        return /四件套|套餐|双人|分享|巨无霸|安格斯|芝士|炸|新地|麦旋风|派|薯条/.test(text);
    }
    if (t === '清淡') {
        return /辣|龙焰|炸|椒|芝士/.test(text);
    }
    return false;
}
/* ------------------------------------------------------------------ */
/* 打分                                                              */
/* ------------------------------------------------------------------ */
function scoreProduct(p, input, tabooWords) {
    const reasons = [];
    let score = 0;
    const text = productText(p);
    const name = (p.name ?? '').toLowerCase();
    const price = p.price ?? 0;
    /* +3 节气关键词 */
    const termHit = input.strategy.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (termHit.length > 0) {
        score += 3;
        reasons.push(`应季（${termHit.join('/')}）`);
    }
    /* +3 本命单品 */
    if (input.snapshot) {
        const top = input.snapshot.topItems.find((t) => name.includes(t.toLowerCase()) || t.toLowerCase().includes(name));
        if (top) {
            score += 3;
            reasons.push(`你的本命（${top}）`);
        }
    }
    /* +2 口味匹配情绪策略 */
    if (input.moodStrategy) {
        const tasteHits = input.moodStrategy.tasteStrategy.filter((t) => {
            const tag = t.toLowerCase();
            return text.includes(tag) || (tag === '甜' && /甜|冰淇淋|新地|可可|糖/.test(text))
                || (tag === '辣' && /辣/.test(text))
                || (tag === '冰' && /冰|冷/.test(text))
                || (tag === '热' && /热|暖/.test(text))
                || (tag === '高碳水' && /堡|薯条|饭|面包/.test(text));
        });
        if (tasteHits.length > 0) {
            score += 2;
            reasons.push(`对情绪有用（${tasteHits.join('/')}）`);
        }
    }
    /* +4 命中用户**嘴上说的**口味偏好（这是最直接的意图，权重最高）
       之前完全没接这条，导致"来点甜的""我要减肥"选出的菜单和"我好烦"一模一样。 */
    if (input.intent.explicit.taste.length > 0) {
        const wantHits = input.intent.explicit.taste.filter((t) => matchTasteTag(t, p.name ?? ''));
        if (wantHits.length > 0) {
            score += 4;
            reasons.push(`你想吃的（${wantHits.join('/')}）`);
        }
    }
    /**
     * 人数匹配：多选题必须优先「一份就够」的整餐。
     *
     * 这是修「两个人点两份单人餐」的核心。
     * 菜单里有现成的双人餐（¥54.9~73.9），但它们的名字里既没有节气关键词
     * 也没有「辣/甜」，打分全是 0，永远排不过「麦辣鸡腿汉堡套餐」——
     * 于是 2 个人只能拿到"单人餐 ×2"，又贵又不合理。
     *
     * 单独给人数匹配计分，让「够吃」这件事本身成为理由。
     */
    const serves = servesOf(p);
    if (serves >= 2) {
        if (serves === input.people) {
            score += 5;
            reasons.push(`一份就够 ${serves} 人吃`);
        }
        else if (serves > input.people) {
            score += 1;
            reasons.push(`够 ${serves} 人吃`);
        }
        else {
            /**
             * 多人餐一份不够，要叠份数（3 人点双人餐 → 2 份 4 人份，略超）。
             *
             * ⚠️ 文案里**不能写死「双人餐」**：早期就是这么写的，
             * 3 人点「三人餐」时 serves(3) < people 落进这个分支，
             * 于是菜单上出现「畅享吃鸡三人餐 · 双人餐，一份够 3 人」——
             * 商品名和理由自相矛盾，用户会以为系统认错了商品。
             * 统一按 `serves` 生成，不猜品类。
             */
            score += 2;
            reasons.push(`${serves} 人份，一份够 ${serves} 人`);
        }
    }
    /* 整餐天然比单点更完整：一份里已经有主食+小食+饮料 */
    if (isCombo(p) && serves === 1 && input.people === 1) {
        score += 1;
    }
    /**
     * 单人场景下，**完整一餐要明显压过单点汉堡**。
     *
     * 这是修「一人点了套餐还再补一杯饮料一份小食」的源头：
     * 套餐（含主食+小食+饮料，¥41）和单点汉堡（¥25.5）在分数上咬得太近，
     * 单点胜出后就只能靠结构上限去补配角，一餐被凑成 4 个 SKU。
     * 让「含饮料含小食」这件事本身值分，套餐就能一次成团。
     */
    if (input.people === 1 && isCombo(p)) {
        const slots = comboSlots(p);
        if (slots.drink > 0)
            score += 2;
        if (slots.side > 0)
            score += 1;
        // 不加 reason：whyOf 已经会补「套餐自带饮料和小食」，这里再说一遍就重复了
    }
    /* +2 用户特制习惯 */
    if (input.snapshot) {
        const custom = input.snapshot.customs.find((c) => {
            const base = c.replace(/(去冰|加冰|少冰|不加|多)/g, '').trim();
            return base && name.includes(base.toLowerCase());
        });
        if (custom) {
            score += 2;
            reasons.push(`你常点的（${custom}）`);
        }
    }
    /* +1 预算区间内 */
    if (input.snapshot?.budgetRange) {
        const [lo, hi] = input.snapshot.budgetRange;
        if (price >= lo * 0.4 && price <= hi * 1.2) {
            score += 1;
            reasons.push('在你平时的价位');
        }
    }
    /* -4 用户明确说"减肥/清淡"时，高热量主餐降权（不硬杀，只是排后面） */
    if (input.intent.explicit.taste.length > 0) {
        const bad = input.intent.explicit.taste.filter((t) => dislikeOf(t, p.name ?? ''));
        if (bad.length > 0) {
            score -= 4;
            reasons.push(`你说要${bad.join('/')}，这个偏重`);
        }
    }
    /* -6 不是吃的：调味酱/周边/毛绒等，混进菜单会很怪 */
    if (isNonFood(p)) {
        score -= 6;
        reasons.push('这不是主餐');
    }
    /* -5 命中 avoid */
    if (input.moodStrategy) {
        const avoidHit = input.moodStrategy.avoid.filter((a) => {
            const tag = a.toLowerCase();
            return text.includes(tag) || (tag === '清淡' && /沙拉|清汤/.test(text))
                || (tag === '小份' && /小份|迷你/.test(text))
                || (tag === '轻食' && /沙拉|轻食/.test(text));
        });
        if (avoidHit.length > 0) {
            score -= 5;
            reasons.push(`此时不合适（${avoidHit.join('/')}）`);
        }
    }
    /* 忌口二次确认（理论上已硬过滤，这里是双保险） */
    for (const w of tabooWords) {
        if (w && text.includes(w)) {
            score -= 100;
            reasons.push(`含忌口（${w}）`);
            break;
        }
    }
    /**
     * 兜底理由：进了菜单就一定要有一句能解释的话。
     * 之前会出现「鱼牛汉堡四件套」这种 why 为空的行，
     * 前端渲染出来是一条光秃秃的商品名，看着像 bug。
     */
    if (reasons.length === 0) {
        const role = roleOf(p);
        if (role === 'main')
            reasons.push('一餐里的主心骨');
        else if (role === 'drink')
            reasons.push('配着吃刚好');
        else if (role === 'dessert')
            reasons.push('收尾来一口');
        else
            reasons.push('顺手加一份');
    }
    return { product: p, score, reasons };
}
/* ------------------------------------------------------------------ */
/* 主流程                                                            */
/* ------------------------------------------------------------------ */
/** 人数 → 建议件数（这里的「件」是不同 SKU 的个数，不是份数） */
function targetCount(people) {
    if (people <= 1)
        return 4;
    if (people === 2)
        return 5;
    if (people <= 4)
        return 6;
    return Math.min(9, 4 + people);
}
/**
 * 是否是「含主食的完整餐」（套餐 / 几件套 / 单人餐 / 双人餐 / 随心选）。
 *
 * ⚠️ 不能用「名字里有没有汉堡」来判断。
 * 实测菜单里「快乐吃鸡双人餐」「精选单人餐四件套」都不含「堡」字，
 * 早期版本因此把它们判成 other，导致份数算成 1、也不受主食上限约束。
 */
export function isCombo(p) {
    const n = p.name ?? '';
    if (/套餐|件套|单人餐|双人餐|多人餐|分享餐|随心选|随心配|组合|拼盘/.test(n))
        return true;
    /**
     * 「畅享吃鸡三人餐」「合家欢聚鸡牛三人餐」「吃鸡盛宴四人餐」
     * 这类只写「N 人餐」、不带「套餐」二字，早期版本全部漏判成单品。
     *
     * 漏判的后果比"少一个候选"严重得多：
     *   · 第一轮「整餐优先」收不到它（combos 只认 isCombo）
     *   · 第二轮「补主食」roleOf 也认不出（名字里没有堡/饭/卷/鸡块）
     *   · 于是它从第三轮「补配角」混进来，被当成一份小食 ——
     *     3 个单人套餐 + 1 份三人餐 = 6 人份，账还是按"够 4 人吃"记的
     * 所以这里必须按「人数词 + 餐」兜住，不能只靠白名单词表。
     */
    return /[一二三四五六两\d]\s*人餐/.test(n);
}
/**
 * 这份「餐」能喂几个人。
 *
 * 这是「两个人点什么」的核心：
 * 菜单里有 4 款真正的双人餐（¥54.9~73.9），
 * 早期版本完全没用上，反而给 2 个人点「单人餐 ×2 + 2 个单品汉堡」，
 * 于是出现"两个汉堡 + 一个单人餐"这种一看就不对的组合。
 */
export function servesOf(p) {
    const n = p.name ?? '';
    if (/双人|两人|2\s*人/.test(n))
        return 2;
    /**
     * 「三人餐」必须回 3，不能塞进 4 这个桶。
     *
     * 早期这里把 `三人|3人` 和 `多人|全家|四人` 合并成一句 return 4，
     * 直接导致两个后果：
     *   1. 打分环节 serves(4) > people(3) 只给 +1（"够 4 人吃"），
     *      而单人套餐 serves(1) 命中「应季·汉堡」拿 +3 —— 三人餐永远排不过它；
     *   2. 份数按 ceil(3/4)=1 算、记账按 4 人份算，账面上"够吃"了，
     *      实际三个人只有一份套餐，于是又补 3 份单人套餐。
     * 人数档位是真实商品属性，不能用"能喂几个人"的近似值糊过去。
     */
    if (/三人|3\s*人/.test(n))
        return 3;
    if (/四人|4\s*人/.test(n))
        return 4;
    if (/多人|全家/.test(n))
        return 4;
    return 1;
}
/** 商品角色：决定份数怎么配 */
function roleOf(p) {
    const s = `${p.category ?? ''} ${p.name ?? ''}`.toLowerCase();
    // 完整餐（含主食）优先判成 main —— 即使名字里没有「堡」
    if (isCombo(p))
        return 'main';
    if (/甜|冰淇淋|新地|圆筒|派/.test(s))
        return 'dessert';
    if (/饮|可乐|coke|咖啡|茶|水|奶/.test(s))
        return 'drink';
    if (/堡|主食|饭|卷|鸡排|鸡块|鸡翅|薯条/.test(s))
        return 'main';
    return 'other';
}
/**
 * 单品的份数。
 *
 * 关键约束：**选品和渲染必须用同一套份数**，否则预算会算错。
 * 早期版本装箱时按单品价算预算，渲染时又按人数放大份数，
 * 结果"4 个人 150 块"实际出了 546 块的账单。
 *
 * 规则（与产品约定一致，tests/selector.test.ts 已锁定）：
 *   单人套餐   → min(people, 4)   一个人一份，多人就是每人一份
 *   双人/多人餐 → ceil(people / serves)  2 个人点 1 份双人餐，不是 2 份
 *   主食单品   → min(people, 4)
 *   饮品/甜品  → ceil(people / 2)
 *   其它      → 1
 */
export function qtyOf(p, people) {
    if (isCombo(p)) {
        const serves = servesOf(p);
        /**
         * 双人/多人餐按「能喂几个人」折算，避免 2 人点了 2 份双人餐 = 4 人份。
         *
         * ⚠️ 这里必须是 ceil，不能改成 floor。
         * 试过 floor（想省掉 3 人时多出来的 1 人份），结果是 3 人会拿到
         * 「双人餐 ×1」后还差 1 个人，于是又补一份单人套餐 ——
         * 而单人套餐的份数是 min(people,4)=3，最终变成 5 人份、价格翻倍。
         * 多 1 人份远好过点错一顿。
         */
        if (serves > 1)
            return Math.max(1, Math.ceil(people / serves));
        return Math.max(1, Math.min(people, 4));
    }
    const role = roleOf(p);
    if (role === 'main')
        return Math.max(1, Math.min(people, 4));
    if (role === 'drink' || role === 'dessert')
        return Math.max(1, Math.ceil(people / 2));
    return 1;
}
/** 一项能供给几个人「吃饭」：双人餐供 2 人，单人餐/单品汉堡供 1 人 */
export function feedCapacity(p, people) {
    return servesOf(p) * qtyOf(p, people);
}
/**
 * 一份套餐自带哪些东西（**按单份算**，份数放大在外层做）。
 *
 * 这是修「一人套餐有饮料啊，但是又点了一杯」的地方。
 * 早期版本只把套餐当成「主食 +1」，套餐里的可乐和薯条完全没记账，
 * 于是结构上限以为「还差一杯饮料」，又给补了一杯无糖可乐 —— 一餐两杯饮料。
 *
 * 两条路径：
 *   1. MCP 给了 `combo` 明细 → 按明细逐项归类，最准；
 *   2. 没给明细 → 用麦当劳套餐的通行结构兜底：一份餐 = 主食 + 小食 + 饮料。
 *
 * 第 2 条看似武断，但方向上只会「少点」不会「多点」：
 * 真实菜单里的「套餐 / 几件套 / 单人餐 / 双人餐 / 随心选」都是完整一餐，
 * 极少出现"只有汉堡没有薯条"的套装。宁可少补一份，也不要端出两杯可乐。
 */
export function comboSlots(p) {
    const serves = servesOf(p);
    const items = Array.isArray(p.combo) ? p.combo : [];
    const out = { main: 0, side: 0, drink: 0, dessert: 0 };
    for (const raw of items) {
        const t = String(raw ?? '').toLowerCase();
        if (!t)
            continue;
        if (/甜|冰淇淋|新地|圆筒|麦旋风|派|蛋糕/.test(t))
            out.dessert++;
        else if (/饮|可乐|coke|雪碧|咖啡|拿铁|美式|茶|果汁|柠檬|牛奶|纯悦|水/.test(t))
            out.drink++;
        else if (/薯条|鸡块|鸡翅|鸡排|玉米|沙拉|苹果|小食|麦乐/.test(t))
            out.side++;
        else if (/堡|饭|卷|主食|鸡腿|鸡胸/.test(t))
            out.main++;
    }
    // 明细为空或一项都没归类成功 → 退回「完整一餐」兜底结构
    if (out.main + out.side + out.drink + out.dessert === 0) {
        return { main: serves, side: serves, drink: serves, dessert: 0 };
    }
    // 明细里只列了饮料小食、没列主食时，主食按人数补齐（主食不吃亏）
    if (out.main === 0)
        out.main = serves;
    return out;
}
/** 一份餐里主食 SKU 的上限：主食是「每人一份」，所以不能堆太多款 */
function maxMainSku(people) {
    return people <= 1 ? 1 : people <= 2 ? 2 : 3;
}
/**
 * 一顿饭的结构上限 —— **总份数**，不是「还能补几份」。
 *
 * 这是修「点得不像人点的」的核心约束 —— 早期只限制了主食 SKU 数，
 * 于是出现「两个新地 + 麦辣鸡腿汉堡 + 汉堡包 + 单人餐」：
 * 1 个人 3 项主食、2 份冰甜品，价格 105 块。
 *
 * 真实点餐的结构是：
 *   主食：每人 1 份（可以有 1-2 款换口味，但总量别超人数）
 *   小食：每人 1 份，多给 1 份余量
 *   饮品：每人 1 杯
 *   甜品：0-1 份（这是"加一份"，不是"来两份"）
 *
 * ⚠️ 语义必须是「总数」而不是「附加数」，因为套餐自带的饮料和小食
 * 也要占用额度。早期按附加数算，1 个人点了含饮料的套餐后结构上限
 * 还以为欠一杯饮料，又补了杯无糖可乐 —— 一餐两杯饮料。
 */
function structureCap(people) {
    return {
        /**
         * 甜品上限。
         *
         * 3 人以上给 2 份，但**必须是两个不同 SKU 各 1 份**的语义太绕，
         * 实际点餐里"两份甜品"通常意味着一人一份小甜点。
         * 这里收紧到「最多 1 个甜品 SKU」：qtyOf 已经按 ceil(people/2) 放大，
         * 3 个人 1 个 SKU ×2 份就是 2 个人有甜点，再加一个 SKU 就成了
         * 圆筒 ×2 + 新地 ×2 = 4 份甜品，比人数还多。
         */
        dessert: people <= 4 ? 1 : 2,
        /**
         * 小食给到「每人 1 份 + 1 份余量」—— 但余量只留给 1-2 人。
         *
         * 为什么 3 人以上不给余量（本次修复）：
         *   多人餐自带的小食是**按人头**给的（三人餐自带 3 份小食），
         *   再给余量就等于"每人一份之后再多一份"，
         *   而补位环节只会挑分数最高的那件 —— 实测挑中了 ¥39.9 的「麦麦炸鸡5拼」，
         *   3 人餐从 ¥128 涨到 ¥161.9。用户要的是三个人吃饭，不是把小食堆满。
         *
         *   1-2 人保留 +1 余量：单人「薯条 + 鸡块」这种双小食确实常见，
         *   而且金额小，不会让账单失控。
         */
        side: people <= 2 ? people + 1 : people,
        drink: Math.min(people, 4),
    };
}
/**
 * 非主餐商品：调味酱、周边、玩具等。
 * 它们确实在菜单里卖，但作为一餐的推荐项出现会很出戏，所以强降权。
 */
export function isNonFood(p) {
    const s = `${p.name ?? ''} ${p.category ?? ''}`;
    return /酱|蘸|周边|毛绒|玩具|手办|盲盒|卡片|礼品|袋|包装|餐具|吸管|纸/.test(s);
}
/**
 * 名称归一化：用于避免同时选中同一款的单品/套餐。
 *
 * 「单人餐」「双人餐」「随心选」这些词必须去掉，
 * 否则「鱼牛汉堡随心选单人餐」和「鱼牛汉堡」会被当成两道不同的菜。
 */
function coreKey(p) {
    return (p.name ?? '')
        .replace(/[（(].*?[)）]/g, '')
        .replace(/(四件套|三件套|二件套|五件套|八件套|套餐|随心选|随心配|单人餐|双人餐|多人餐|分享餐|组合|拼盘)/g, '')
        .replace(/[×xX*\s·・\-—_/]/g, '')
        .slice(0, 4);
}
export function selectProducts(input) {
    const tabooWords = expandTaboo([...input.intent.explicit.taboo, ...(input.snapshot?.taboo ?? [])]);
    const excluded = [];
    /* --- 1. 硬过滤 --- */
    const candidates = [];
    /** 随单购加购项：必须搭配主商品才能下单，单独成单会失败，所以不进主选品 */
    const withOrderPool = [];
    for (const p of input.products) {
        if (!p?.name)
            continue;
        if (p.available === false)
            continue;
        const text = productText(p);
        const hit = tabooWords.find((w) => w.length >= 1 && text.includes(w));
        if (hit) {
            excluded.push({ product: p, reason: `含忌口「${hit}」` });
            continue;
        }
        if ((p.price ?? 0) <= 0)
            continue;
        if (p.withOrderOnly) {
            withOrderPool.push(p);
            continue;
        }
        candidates.push(p);
    }
    /* --- 2. 打分排序 --- */
    /**
     * 需要避开的商品：只降权，不删除。
     *
     * 三路来源（都在编排器里合并后传进来）：
     *   · 判断环节认定"骨架不对，最该换掉"的
     *   · 旁路判断说"刚吃过 / 别推"的
     *   · **用户手动从购物车删掉的**（最强信号，也是最容易被忽略的）
     *
     * 降到 -1 就足够 —— 选品各轮都跳过 `score < 0` 的项，
     * 但兜底（pick 最便宜几件）仍能找到它们，不至于凑不出单。
     * 这一点很重要：宁可推一个"理论上该避开"的，也不能让用户拿到空菜单。
     */
    const avoidHit = (p) => {
        const names = input.avoidNames ?? [];
        if (names.length === 0)
            return false;
        const n = p.name ?? '';
        return names.some((a) => a.trim() !== '' && (n.includes(a.trim()) || a.trim().includes(n)));
    };
    const details = candidates
        .map((p) => {
        const d = scoreProduct(p, input, tabooWords);
        if (avoidHit(p)) {
            // 保证一定落到负分，不管原本得了多少
            return { ...d, score: Math.min(d.score, 0) - 1, reasons: ['这次先跳过（之前点过或用户删掉了）'] };
        }
        return d;
    })
        .sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        // 平手时按价格升序（更稳），再按名字保证稳定
        const pa = a.product.price ?? 0;
        const pb = b.product.price ?? 0;
        if (pa !== pb)
            return pa - pb;
        return (a.product.name ?? '').localeCompare(b.product.name ?? '');
    });
    /* --- 3. 按预算装箱（贪心，**份数参与计价**） --- */
    const want = targetCount(input.people);
    const people = input.people;
    const picked = [];
    /** 已花的钱：按 单价 × 份数 累计，和最终菜单一致 */
    let spent = 0;
    const seenCore = new Set();
    /** 主食 SKU 上限：主食已经按人数配份数了，不需要堆太多款 */
    const maxMains = maxMainSku(people);
    const cap = structureCap(people);
    let mains = 0;
    let desserts = 0;
    let sides = 0;
    let drinks = 0;
    /** 已经能喂饱几个人（双人餐算 2 人） */
    let fed = 0;
    const overCap = (role) => {
        if (role === 'main')
            return false; // 主食由 fed / maxMains 单独控制
        if (role === 'dessert')
            return desserts >= cap.dessert;
        if (role === 'drink')
            return drinks >= cap.drink;
        return sides >= cap.side;
    };
    const take = (p) => {
        const role = roleOf(p);
        const key = `${role}:${coreKey(p)}`;
        if (seenCore.has(key))
            return false;
        const qty = qtyOf(p, people);
        const lineTotal = Math.round((p.price ?? 0) * qty * 100) / 100;
        if (input.budget !== undefined && spent + lineTotal > input.budget)
            return false;
        if (role === 'main' && mains >= maxMains)
            return false;
        if (overCap(role))
            return false;
        picked.push(p);
        seenCore.add(key);
        spent += lineTotal;
        if (role === 'main') {
            mains++;
            fed += feedCapacity(p, people);
            /**
             * 套餐自带的饮料/小食/甜品要**占用结构额度**。
             *
             * 这是修「一人套餐有饮料啊，但是又点了一杯」的地方：
             * 麦辣鸡腿汉堡套餐里本来就有可乐和薯条，如果不记账，
             * 结构上限会认为"还欠一杯饮料 + 一份小食"，紧接着补上
             * 无糖可口可乐和麦乐鸡 5 块 —— 一个人一餐两杯饮料两份小食。
             */
            if (isCombo(p)) {
                const slots = comboSlots(p);
                drinks += slots.drink * qty;
                sides += slots.side * qty;
                desserts += slots.dessert * qty;
            }
        }
        else if (role === 'dessert')
            desserts++;
        else if (role === 'drink')
            drinks++;
        else
            sides++;
        return true;
    };
    /**
     * 第一轮：优先「整餐」，按**人数匹配度**分层，而不是只看分数。
     *
     * 为什么整餐优先：套餐/几件套/双人餐本身就是一份完整的一餐
     * （主食+小食+饮料），比「单点汉堡 + 单点薯条 + 单点可乐」更合算也更像人点的。
     *
     * 为什么要分层（本次修复的核心）：
     *   分数是**加权求和**，节气关键词（+3）、口味（+4）这些项对单人套餐同样生效。
     *   3 人时「吉士汉堡套餐」（serves=1，命中"汉堡" +3）得分 3，
     *   「畅享吃鸡三人餐」即便拿了「一份就够 3 人吃」的 +5 ——
     *   一旦菜单里有个名字带"辣/甜/板烧"的单人套餐（+4 口味），
     *   单人套餐仍会排到三人餐前面，然后 ×3 份把三个人名额全占了，
     *   三人餐再无机会。这不是权重没调好，而是**两类商品根本不可比**：
     *   "一份 3 人份的餐"和"3 份 1 人餐"在总价、剩菜、饮品份数上完全不同。
     *   所以做成结构优先级，而不是继续在分数上加权重。
     *
     * 分层顺序：
     *   0 档  serves === people      刚好一份够所有人吃（最优）
     *   1 档  serves > people        一份有多，比如 2 人点三人餐
     *   2 档  serves ≥ 2 且 < people 多人餐，一份不够，按 qtyOf 叠份数
     *   3 档  serves === 1           单人餐（只在凑不出多人餐时才用）
     *
     * 同档内：超额人数少的优先 → 覆盖人数多的优先 → 分数高的优先 → 便宜的优先。
     * 「超额」= serves × qtyOf − people，即按现有份数规则真会多出来的份数。
     */
    const tierOf = (p) => {
        const s = servesOf(p);
        if (s === people)
            return 0;
        if (s > people)
            return 1;
        if (s >= 2)
            return 2;
        return 3;
    };
    const overOf = (p) => {
        const s = servesOf(p);
        if (s < 2)
            return Math.max(0, people - 1);
        return s * qtyOf(p, people) - people;
    };
    const combos = details
        .filter((d) => d.score >= 0 && isCombo(d.product))
        .sort((a, b) => {
        const ta = tierOf(a.product);
        const tb = tierOf(b.product);
        if (ta !== tb)
            return ta - tb;
        const oa = overOf(a.product);
        const ob = overOf(b.product);
        if (oa !== ob)
            return oa - ob;
        const sa = servesOf(a.product);
        const sb = servesOf(b.product);
        if (sa !== sb)
            return sb - sa;
        if (b.score !== a.score)
            return b.score - a.score;
        return (a.product.price ?? 0) - (b.product.price ?? 0);
    });
    for (const d of combos) {
        if (picked.length >= want)
            break;
        if (fed >= people)
            break; // 已经够吃了
        take(d.product);
    }
    /* 第二轮：整餐没喂饱 → 用单品汉堡补缺口 */
    if (fed < people) {
        for (const d of details) {
            if (picked.length >= want)
                break;
            if (fed >= people)
                break;
            if (d.score < 0)
                continue;
            if (isCombo(d.product))
                continue;
            if (roleOf(d.product) !== 'main')
                continue;
            take(d.product);
        }
    }
    /* 第三轮：补配角（小食 / 饮品 / 甜品），按结构上限控制 */
    /**
     * 配角单价不得超过主餐单价的 60%。
     *
     * 为什么加这条（本次修复）：
     *   补位环节会挑分数最高的那件，而"在用户平时价位"这个 +1 分对小食也生效，
     *   于是 ¥55.9 的双人餐后面跟了一份 ¥39.9 的「麦麦炸鸡5拼」——
     *   两个人一餐 ¥118.3，跟三个人的 ¥122 几乎一样。
     *   现实里没人会给双人餐再配一份四成价钱的拼盘，配角在量级上必须明显小于主餐。
     *
     * ⚠️ 不能用「不超过主餐单价」这种绝对比较：¥39.9 < ¥55.9，
     * 拼盘照样能过 —— 实测就是这么漏过去的。
     * 60% 这个比例是参照真实菜单定的：双人餐 ¥55.9 → 上限 ¥33.5（¥39.9 拼盘出局，
     * ¥15 麦乐鸡、¥13.5 新地都还在）；单套餐 ¥32 → 上限 ¥19.2，小食甜品全能进。
     *
     * 没有主餐时（纯小食单）不限制，否则会一件都选不出来。
     */
    const mainUnitPrice = Math.max(0, ...picked.filter((p) => roleOf(p) === 'main').map((p) => p.price ?? 0));
    const sidePriceCap = mainUnitPrice * 0.6;
    for (const d of details) {
        if (picked.length >= want)
            break;
        if (d.score < 0)
            continue;
        const role = roleOf(d.product);
        if (role === 'main')
            continue;
        if (overCap(role))
            continue;
        if (mainUnitPrice > 0 && (d.product.price ?? 0) > sidePriceCap)
            continue;
        take(d.product);
    }
    /**
     * --- 4. 预算还有余量 → 尝试加一份「有意义」的甜品/小食 ---
     *
     * ⚠️ 必须走 take()。早期这段自己 push + 自己 `desserts++`，
     * 绕过了 seenCore 去重和结构上限，是"重复配置"的另一个漏点。
     */
    if (input.budget !== undefined && picked.length > 0 && picked.length < want) {
        const extra = details.find((d) => {
            if (picked.includes(d.product) || d.score <= 0)
                return false;
            if (!/甜|冰淇淋|圆筒|新地|薯条|玉米/.test(d.product.name ?? ''))
                return false;
            if (isCombo(d.product))
                return false;
            const role = roleOf(d.product);
            if (overCap(role))
                return false;
            return !seenCore.has(`${role}:${coreKey(d.product)}`);
        });
        if (extra)
            take(extra.product);
    }
    /* --- 5. 兜底：一件都没选出来时，取最便宜的几件 --- */
    if (picked.length === 0 && details.length > 0) {
        const cheapest = [...details].sort((a, b) => (a.product.price ?? 0) - (b.product.price ?? 0));
        for (const d of cheapest) {
            if (picked.length >= Math.min(3, want))
                break;
            if (take(d.product))
                continue;
            // take() 被预算拦下也要出东西，否则用户拿到空菜单；这里只补一次保底
            if (picked.length === 0) {
                picked.push(d.product);
                seenCore.add(`${roleOf(d.product)}:${coreKey(d.product)}`);
                spent += (d.product.price ?? 0) * qtyOf(d.product, people);
            }
        }
    }
    /**
     * --- 6. 随单购项：只在**没吃饱**时才补作加购 ---
     *
     * 关键修正：随单购里混着「鱼牛汉堡随心选单人餐」这种含主食的完整餐。
     * 早期不管三七二十一往菜单里塞，结果出现「汉堡包 + 麦辣鸡腿汉堡 +
     * 鱼牛汉堡单人餐」——1 个人 3 项主食。
     * 现在只有 `fed < people`（还没喂饱）才允许补，且同样受主食上限约束。
     */
    if (picked.length > 0 && withOrderPool.length > 0 && fed < people) {
        const extras = withOrderPool
            .map((p) => scoreProduct(p, input, tabooWords))
            .filter((d) => d.score > 0 && !picked.includes(d.product))
            .sort((a, b) => b.score - a.score);
        for (const d of extras) {
            if (fed >= people)
                break;
            if (picked.length >= want + 1)
                break;
            take(d.product);
        }
    }
    return { items: picked, details, excluded };
}
/**
 * 推荐理由：菜单里每一行都必须有一句能解释的话。
 *
 * 有些商品是通过「预算补位 / 随单购加购」进菜单的，它们可能没有出现在
 * details 里（或 reasons 为空），之前会渲染成一整行空白，看着像 bug。
 *
 * 套餐额外说明「自带什么」：用户看到菜单里没有单独的可乐会以为漏了，
 * 补一句「套餐自带饮料」比让他在订单页自己发现更省心。
 */
function whyOf(p, d) {
    const fromReasons = (d?.reasons ?? []).slice(0, 2).join('，');
    if (isCombo(p)) {
        const s = comboSlots(p);
        const has = [];
        if (s.drink > 0)
            has.push('饮料');
        if (s.side > 0)
            has.push('小食');
        if (has.length > 0) {
            const note = `套餐自带${has.join('和')}`;
            return fromReasons ? `${fromReasons}，${note}` : note;
        }
    }
    if (fromReasons)
        return fromReasons;
    const role = roleOf(p);
    if (role === 'main')
        return '一餐里的主心骨';
    if (role === 'drink')
        return '配着吃刚好';
    if (role === 'dessert')
        return '收尾来一口';
    return '顺手加一份';
}
/** 把选中的商品转成 ChatReply.menu（数量、spec、why） */
export function buildMenuItems(input) {
    const { picked, details, people, snapshot } = input;
    const detailMap = new Map(details.map((d) => [d.product, d]));
    return picked.map((p) => {
        const d = detailMap.get(p);
        const price = p.price ?? 0;
        // 份数必须和选品装箱时完全一致，否则预算校验会失真
        const qty = qtyOf(p, people);
        const parts = [`×${qty}`];
        // 特制建议：从用户习惯里找
        if (snapshot) {
            const base = p.name ?? '';
            const custom = snapshot.customs.find((c) => {
                const b = c.replace(/(去冰|加冰|少冰|不加|多)/g, '').trim();
                return b && base.toLowerCase().includes(b.toLowerCase());
            });
            if (custom)
                parts.push(custom.replace(/^.*?(去冰|加冰|少冰)/, '$1'));
        }
        const item = {
            name: p.name,
            spec: parts.join(' · '),
            why: whyOf(p, d),
            price: Math.round(price * qty * 100) / 100,
        };
        const pid = p.productId ?? p.id ?? p.code;
        if (pid)
            item.productId = String(pid);
        if (p.originalPrice !== undefined && p.originalPrice > price) {
            item.originalPrice = Math.round(p.originalPrice * qty * 100) / 100;
        }
        if (p.modifications && p.modifications.length > 0) {
            item.modifications = p.modifications.slice(0, 3);
        }
        return item;
    });
}
//# sourceMappingURL=selector.service.js.map