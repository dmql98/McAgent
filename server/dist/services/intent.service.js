/* ------------------------------------------------------------------ */
/* 关键词表                                                          */
/* ------------------------------------------------------------------ */
const MOOD_KEYWORDS = [
    {
        mood: '烦躁',
        words: [
            '烦', '气死', '崩溃', '无语', '受不了', '抓狂', '火大', '裂开', '绷不住',
            '暴躁', '想揍', '遭不住', '麻了', '烦死', '心梗', '爆炸',
        ],
    },
    {
        mood: '低落',
        words: [
            '难过', 'emo', '想哭', '失落', '孤独', '委屈', '丧', '抑郁', '心累',
            '不开心', '难受', '低落', '空落落', '没意思', '提不起劲', '没人',
        ],
    },
    {
        mood: '疲惫',
        words: [
            '累', '困', '熬夜', '加班', '没力气', '瘫', '虚', '扛不住', '肝',
            '好累', '累死', '乏', '打不动', '不想动', '没精神',
        ],
    },
    {
        mood: '庆祝',
        words: [
            '庆祝', '生日', '升职', '拿到', '中奖', '约', '聚', '过节', '纪念',
            '上岸', 'offer', '通过了', '搞定', '拿到了', '发工资',
        ],
    },
    {
        mood: '开心',
        words: ['开心', '爽', '棒', '美滋滋', '太好了', '赞', '舒服', '高兴', '快乐', '不错'],
    },
    {
        mood: '平淡',
        words: ['随便', '都行', '看你的', '不知道吃', '没什么', '一般', '还好'],
    },
];
/** 极端低落：触发温和模式，禁玩梗 */
const SAFETY_KEYWORDS = [
    '想死', '不想活', '活着没意思', '没意义', '撑不下去', '不想活', '自杀',
    '结束自己', '想消失', '没有希望', '绝望',
];
/** 讽刺/反语：带"呢/啊"的语气词，通常是反着说的 */
const IRONY_PATTERN = /(太好了|真棒|真好啊|好得很|真行|可以啊)[呢啊~～]|呵呵/;
/* ------------------------------------------------------------------ */
/* 抽取工具                                                          */
/* ------------------------------------------------------------------ */
const CN_NUM = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
function cnToNum(s) {
    if (/^\d+$/.test(s))
        return parseInt(s, 10);
    if (s === '十')
        return 10;
    if (s.length === 2 && s[0] === '十')
        return 10 + (CN_NUM[s[1]] ?? 0);
    if (s.length === 2 && s[1] === '十')
        return (CN_NUM[s[0]] ?? 0) * 10;
    if (s.length === 3 && s[1] === '十')
        return (CN_NUM[s[0]] ?? 0) * 10 + (CN_NUM[s[2]] ?? 0);
    return CN_NUM[s];
}
/**
 * 从话里抽人数。
 *
 * ⚠️ 数量词和人数必须分开：「两个汉堡」是 2 个汉堡，不是 2 个人。
 * 早期版本只认「数字 + 个/位/人」，于是「两个汉堡一杯可乐」被判成 2 人，
 * 系统按 2 人份配菜 —— 用户一个人吃，收到双份主食。
 * 现在「个」后面如果紧跟食物名，就不当人数。
 */
/** 量词后面跟这些词，说明在数吃的，不是在数人 */
const FOOD_AFTER_GE = /^(汉堡|堡|薯条|可乐|鸡块|鸡翅|鸡腿|派|新地|圆筒|麦旋风|咖啡|奶茶|饮料|套餐|餐|份|杯|串|玉米|沙拉|苹果|汤|饭|卷|鸡肉|牛肉|鱼|奶昔|果汁|水)/;
function extractPeople(text) {
    // 4个人 / 4人 / 两个人 / 两位 / 我们仨
    const re = /(\d+|[一二两三四五六七八九十]+)\s*([个位人])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const unit = m[2];
        // 「两个汉堡」这种是数量，跳过，继续找后面真正的人数
        if (unit === '个' && FOOD_AFTER_GE.test(text.slice(m.index + m[0].length)))
            continue;
        const n = cnToNum(m[1]);
        if (n && n > 0 && n <= 30)
            return n;
    }
    if (/我们仨|三人/.test(text))
        return 3;
    if (/我和同事|我俩|我们俩/.test(text))
        return 2;
    if (/一个人|单人|自己吃|就我/.test(text))
        return 1;
    if (/两个人|情侣|和对象/.test(text))
        return 2;
    return undefined;
}
function extractBudget(text) {
    const patterns = [
        /预算\s*(\d+(?:\.\d+)?)/,
        /(\d+(?:\.\d+)?)\s*(?:块|元|块钱|rmb|RMB)/,
        /不超过\s*(\d+(?:\.\d+)?)/,
        /(\d+(?:\.\d+)?)\s*以内/,
        /预算\s*(\d+)/,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) {
            const n = parseFloat(m[1]);
            if (n > 0 && n <= 10000)
                return n;
        }
    }
    return undefined;
}
/** 剥掉忌口词前面的主语/助词，「我花生过敏」→「花生」 */
function stripPrefix(w) {
    let s = w.trim();
    // 前缀常见虚词/代词（按长度从长到短剥，最多剥两层）
    const prefixes = ['我们', '他们', '她们', '我家', '我对', '本人', '我', '你', '他', '她', '对', '有', '是', '吃', '的', '了'];
    for (let round = 0; round < 2; round++) {
        let changed = false;
        for (const p of prefixes) {
            if (s.length > p.length && s.startsWith(p)) {
                s = s.slice(p.length);
                changed = true;
                break;
            }
        }
        if (!changed)
            break;
    }
    // 后缀剥「过敏」「不能吃」等
    for (const suf of ['过敏', '不能吃', '不吃']) {
        if (s.length > suf.length && s.endsWith(suf))
            s = s.slice(0, -suf.length);
    }
    return s.trim();
}
/** 忌口抽取：区分硬约束（不吃/过敏）与软偏好（少/不要那么） */
function extractTaboo(text) {
    const taboo = [];
    const soft = [];
    // 硬约束模式
    const hardPatterns = [
        // 「不要」后面接「太/那么/这么/很」时是软偏好，不是硬约束
        /(?:不吃|不能吃|不要(?!太|那么|这么|很)|别放|别加|忌口|讨厌|受不了)\s*([\u4e00-\u9fa5]{1,4})/g,
        /([\u4e00-\u9fa5]{1,5})\s*过敏/g,
        /(?:免|去)\s*([\u4e00-\u9fa5]{1,3})/g,
    ];
    const stopWords = new Set(['饭', '东西', '这个', '那个', '太', '多', '我', '你', '他', '她']);
    for (const p of hardPatterns) {
        for (const m of text.matchAll(p)) {
            const raw = m[1]?.trim();
            if (!raw)
                continue;
            const w = stripPrefix(raw);
            if (w && !stopWords.has(w) && w.length >= 1 && w.length <= 4)
                taboo.push(w);
        }
    }
    // 软偏好：不要太辣 / 少放辣 / 微辣
    const softPatterns = [
        /(?:不要太|少放|少|别太|不太)\s*([\u4e00-\u9fa5]{1,3})/g,
        /(微辣|少辣|少冰|去冰|常温)/g,
    ];
    for (const p of softPatterns) {
        for (const m of text.matchAll(p)) {
            const w = (m[1] ?? m[0]).trim();
            if (w)
                soft.push(w);
        }
    }
    // 特殊：「有人不吃辣」这种多人场景，「不吃辣」是硬约束
    if (/不吃辣|不要辣|免辣|不辣/.test(text)) {
        if (!taboo.includes('辣'))
            taboo.push('辣');
    }
    return { taboo: uniq(taboo), soft: uniq(soft) };
}
function extractTaste(text) {
    const out = [];
    const map = [
        [/(想吃|要|来点|多来).{0,3}甜|甜(的|一点|点)|甜品/, '甜'],
        /**
         * ⚠️「带劲」必须收录。
         *
         * 这是防死循环的关键：反问文案里写的是"想吃点带劲的还是舒服的"，
         * 用户照着回"来点带劲的"，如果系统不认这个词，就会**再问一遍一模一样的话** ——
         * 用户唯一的出路是把那句反问原样读一遍，而那也不认。
         * 凡是我们在文案里教用户说的话，解析层必须认。
         */
        [/(想吃|要|来点|多来).{0,3}辣|辣(的|一点|点)|重口|带劲|带劲儿|过瘾|爽(一点|点)?|刺激/, '辣'],
        [/冰(的|一点|点)?|要冰|加冰/, '冰'],
        [/热(的|一点|点)|热饮|热的|暖(和|一点|点)?/, '热'],
        [/清淡|不油腻|清爽|舒服(的|一点|点)?|温和/, '清淡'],
        [/减肥|减脂|控卡|低卡|不胖|少吃点|轻食/, '减肥'],
        [/大份|加量|多点/, '大份'],
        [/咖啡|提神/, '咖啡'],
        [/薯条/, '薯条'],
        [/可乐/, '可乐'],
    ];
    for (const [re, tag] of map) {
        if (re.test(text) && !out.includes(tag))
            out.push(tag);
    }
    return out;
}
function extractFulfillment(text) {
    if (/外送|送来|送到|外卖|配送/.test(text))
        return '外送';
    if (/堂食|店里吃|在店/.test(text))
        return '堂食';
    if (/自取|到店取|自己拿|柜台/.test(text))
        return '自取';
    return undefined;
}
function extractTimeHint(text, now) {
    const p = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const hints = [
        [/今天|今儿|现在|马上|立刻/, 0],
        [/明天|明儿|明早|明午|明晚/, 1],
        [/后天/, 2],
        [/大后天/, 3],
    ];
    let hint;
    let offset = null;
    for (const [re, off] of hints) {
        const m = text.match(re);
        if (m) {
            hint = m[0];
            offset = off;
            break;
        }
    }
    if (offset === null)
        return {};
    const target = new Date(base);
    target.setDate(target.getDate() + offset);
    return { hint, date: iso(target) };
}
function uniq(arr) {
    return [...new Set(arr)];
}
/* ------------------------------------------------------------------ */
/* 情绪分类                                                          */
/* ------------------------------------------------------------------ */
function classifyMood(text) {
    const lower = text.toLowerCase();
    // 讽刺检测优先于正向
    const ironic = IRONY_PATTERN.test(text);
    let best = null;
    for (const { mood, words } of MOOD_KEYWORDS) {
        let hits = 0;
        for (const w of words) {
            if (lower.includes(w.toLowerCase()))
                hits++;
        }
        if (hits > 0) {
            // 优先级高的先占：只在严格大于时替换
            if (!best || hits > best.hits)
                best = { mood, hits };
        }
    }
    if (ironic) {
        return { mood: '烦躁', confidence: 0.5 };
    }
    if (!best)
        return { mood: null, confidence: 0 };
    if (best.mood === '平淡')
        return { mood: '平淡', confidence: 0.4 };
    const confidence = Math.min(0.95, 0.6 + best.hits * 0.15);
    return { mood: best.mood, confidence };
}
/* ------------------------------------------------------------------ */
/* 对外入口                                                          */
/* ------------------------------------------------------------------ */
const VAGUE_PATTERNS = /^(随便|都行|你决定|看你的|不知道|不知道吃什么|无所谓|随便吧|都ok|都可以)[。！!？?~～\s]*$/;
/**
 * 「我要点餐」这句话本身就是一个明确的约束 —— 表态了"现在就要吃、给我配一单"。
 *
 * 这是修「帮我点个午餐被反问"想吃带劲的还是舒服的"」的地方。
 * 用户已经说了要点午餐，系统还问他"你想吃哪种感觉"，
 * 是把"要不要吃"和"吃什么口味"混为一谈了。
 * 只有连"要不要吃"都没表态（只说"今天好烦"）时，反问才成立。
 */
const ORDER_INTENT_PATTERNS = [
    /点(个|一份|一份儿|份|些)?(餐|饭|午餐|早饭|早餐|晚饭|夜宵|下午茶|外卖|东西|吃的|单)/,
    /帮我(点|买|要)/,
    /来(一|个|份|点)/,
    /(我|肚子)(饿|想吃|要吃饭)/,
    /(吃|来)(午饭|晚饭|早餐|早饭|午餐|夜宵)/,
    /(午饭|晚饭|早餐|早饭|午餐|夜宵)(吃|来|点)/,
    /给(我|咱)(来|点|配)/,
    /**
     * 「吃什么 / 吃啥」是明确在问吃的。
     * 但「不知道吃什么」是**表态不知道**，必须反问 —— 所以要用负向断言排掉。
     */
    /(?<!不晓|不知道|不清楚)(吃|点)(啥|什么)$/,
    /推荐|来一单|配一单|下一单/,
];
function hasOrderIntent(text) {
    return ORDER_INTENT_PATTERNS.some((re) => re.test(text));
}
export function parseIntent(rawInput, now = new Date()) {
    const text = (rawInput ?? '').trim();
    const textNoSpace = text.replace(/\s+/g, '');
    const safetyMode = SAFETY_KEYWORDS.some((k) => text.includes(k));
    const { taboo, soft } = extractTaboo(textNoSpace);
    const people = extractPeople(textNoSpace);
    const budget = extractBudget(textNoSpace);
    const taste = uniq([...extractTaste(textNoSpace), ...soft]);
    const fulfillment = extractFulfillment(textNoSpace);
    const time = extractTimeHint(textNoSpace, now);
    const explicit = { taboo, taste };
    if (people !== undefined)
        explicit.people = people;
    if (budget !== undefined)
        explicit.budget = budget;
    if (fulfillment)
        explicit.fulfillment = fulfillment;
    if (time.hint)
        explicit.timeHint = time.hint;
    if (time.date)
        explicit.targetDate = time.date;
    const { mood, confidence } = classifyMood(textNoSpace);
    // 反问判定
    /**
     * taste 也算「用户已经说清楚了」。
     * 之前只看 people/budget/taboo，导致"来点甜的""想吃清淡的"这种
     * 已经把口味讲明白的请求，仍然被反问"想吃带劲的还是舒服的"——
     * 用户明明说了，系统却装作没听见，这是最伤体验的一种。
     */
    /**
     * 「明确说了要点餐」也算说清楚了。
     *
     * 「帮我点个午餐」「我饿了」「来个饭」这类话没有任何口味/人数/预算信息，
     * 但它明确表态了"现在就要吃、给我配一单"。
     * 早期只看 people/budget/taboo/taste，于是这些话全部被反问
     * 「想吃带劲的还是舒服的」—— 用户已经说要吃饭了，还问他想吃哪种感觉，
     * 等于把"要不要吃"和"吃什么口味"搞混了。
     */
    const orderIntent = hasOrderIntent(textNoSpace);
    const hasExplicit = people !== undefined ||
        budget !== undefined ||
        taboo.length > 0 ||
        taste.length > 0 ||
        fulfillment !== undefined ||
        Boolean(time.hint) ||
        orderIntent;
    /**
     * 新架构下的清晰度口径。
     *
     * 与旧的 hasExplicit 有一处**刻意的差别**：`time.hint` 不再算约束。
     *
     * 为什么：「今天」「现在」这类词几乎每句话都有，但它不告诉你吃什么。
     * 旧逻辑把「今天好烦」判成"有明确约束"（因为有"今天"），
     * 于是不走反问也不走旁路，直接硬选品 —— 选出来的东西纯靠规则猜。
     * 新口径下时间只是背景，不是约束。
     */
    const hasHardConstraint = people !== undefined || budget !== undefined || taboo.length > 0 || taste.length > 0;
    const ruleClarity = ruleClarityOf(hasHardConstraint);
    // 明确指定了口味的（甜/辣/清淡/减肥…）不再反问，直接给菜单
    const isVague = (!hasExplicit && VAGUE_PATTERNS.test(textNoSpace)) || /^(吃什么|吃啥)$/.test(textNoSpace);
    let needsClarify = false;
    let clarifyQuestion;
    if (!safetyMode && !hasExplicit && (isVague || confidence < 0.3)) {
        needsClarify = true;
        clarifyQuestion = pickClarify(mood);
    }
    // 情绪不明确且没有任何约束 → 反问一次（PRD §6 FR-2）
    if (!safetyMode && !needsClarify && mood === null && !hasExplicit && text.length <= 12) {
        needsClarify = true;
        clarifyQuestion = '听起来你现在有点说不上来的状态——是想吃点带劲的发泄一下，还是想吃点舒服的被安慰一下？';
    }
    return {
        explicit,
        mood,
        moodConfidence: safetyMode ? 1 : confidence,
        needsClarify,
        ...(clarifyQuestion ? { clarifyQuestion } : {}),
        safetyMode,
        source: 'rule',
        raw: text,
        clarity: ruleClarity,
        orderIntent,
    };
}
/**
 * 规则层的「清晰度」判定。
 *
 * 注意这**只是兜底**：正常链路里 clarity 由 llm-intent.service 的模型判定。
 * 只有模型超时/失败时才会用到这里的结论。
 *
 * 口径与模型一致：光靠这句话能不能直接在菜单上挑出东西。
 * 能 → clear；只能看出"这人现在有状态"→ vague。
 */
function ruleClarityOf(hasHardConstraint) {
    return hasHardConstraint ? 'clear' : 'vague';
}
function pickClarify(mood) {
    if (mood === '疲惫')
        return '累了的话，是想吃点热的垫一垫，还是想来点冰的提提神？';
    if (mood === '低落')
        return '那今天想吃点热的暖一下，还是吃点甜的？';
    return '今天是想吃点带劲的，还是想吃点舒服的？';
}
export const __intentInternal = {
    extractPeople,
    extractBudget,
    extractTaboo,
    extractTaste,
    extractFulfillment,
    extractTimeHint,
    classifyMood,
    cnToNum,
    SAFETY_KEYWORDS,
};
//# sourceMappingURL=intent.service.js.map