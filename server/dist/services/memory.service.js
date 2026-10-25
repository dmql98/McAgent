/**
 * 记忆服务
 *
 * 设计：依赖注入 MemoryStore，纯逻辑 + 去重规则，不直接碰 DB。
 * 持久化实现见 sqlite-store.ts（M4 接线时用）。
 *
 * 去重规则（契约 §3.1）：
 * - topItems ≤ 5（按频次，同频按最近）
 * - customs ≤ 10
 * - habits.orders ≤ 50
 * - moodDiary ≤ 30（同日同 mood 覆盖）
 * - 任意字符串 ≤ 200 字符
 * - 整体 JSON ≤ 8KB，超了 moodDiary 裁到 10 条
 */
import { createLogger } from '../lib/logger.js';
import { getStarSign } from './knowledge.service.js';
const log = createLogger('memory');
const LIMITS = {
    topItems: 5,
    customs: 10,
    orders: 50,
    moodDiary: 30,
    strField: 200,
    totalBytes: 8 * 1024,
};
export function emptyMemory() {
    return {
        schemaVersion: 1,
        version: 0,
        profile: { taboo: [] },
        taste: { topItems: [], customs: [] },
        habits: { orders: [], usualSlots: [] },
        moodDiary: [],
        rituals: {},
        updatedAt: Date.now(),
    };
}
function truncate(s, n = LIMITS.strField) {
    if (typeof s !== 'string')
        return '';
    return s.length > n ? s.slice(0, n) : s;
}
function todayIso(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export class MemoryService {
    store;
    constructor(store) {
        this.store = store;
    }
    load(userId) {
        return this.store.load(userId) ?? emptyMemory();
    }
    /** 首次登录时初始化，已存在则不动 */
    async ensureInitialized(userId) {
        const existing = this.store.load(userId);
        if (existing)
            return;
        const m = emptyMemory();
        this.save(userId, m);
        log.info(`记忆库初始化 user=${userId}`);
    }
    save(userId, m) {
        m.updatedAt = Date.now();
        m.version = (m.version ?? 0) + 1;
        this.dedupe(m);
        this.store.save(userId, m);
    }
    /* ---------------------------------------------------------------- */
    /* 去重与裁剪                                                        */
    /* ---------------------------------------------------------------- */
    dedupe(m) {
        m.taste.topItems = dedupeStrings(m.taste.topItems).slice(0, LIMITS.topItems);
        m.taste.customs = dedupeStrings(m.taste.customs).slice(0, LIMITS.customs);
        m.habits.orders = m.habits.orders.slice(0, LIMITS.orders);
        // moodDiary：同日同 mood 覆盖（保留最新），再按时间降序取前 30
        const seen = new Map();
        for (const e of m.moodDiary) {
            const key = `${e.date}|${e.mood}`;
            const prev = seen.get(key);
            if (!prev || (e.date >= prev.date && (e.recommended ?? '') !== '')) {
                seen.set(key, {
                    ...e,
                    trigger: truncate(e.trigger),
                    recommended: e.recommended ? truncate(e.recommended) : undefined,
                    feedback: e.feedback ? truncate(e.feedback) : undefined,
                });
            }
        }
        m.moodDiary = [...seen.values()]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
            .slice(0, LIMITS.moodDiary);
        m.habits.usualSlots = dedupeStrings(m.habits.usualSlots).slice(0, 5);
        if (m.profile.nickname)
            m.profile.nickname = truncate(m.profile.nickname, 30);
        m.profile.taboo = dedupeStrings(m.profile.taboo).slice(0, 20);
        // 总量保护
        if (JSON.stringify(m).length > LIMITS.totalBytes) {
            m.moodDiary = m.moodDiary.slice(0, 10);
            log.warn(`记忆体积超限，moodDiary 裁到 10 条 (${m.profile.nickname ?? 'anon'})`);
        }
    }
    /* ---------------------------------------------------------------- */
    /* 写入                                                              */
    /* ---------------------------------------------------------------- */
    /** 三连问 / 资料修改同步进记忆库 */
    async applyProfile(userId, patch) {
        const m = this.load(userId);
        if (patch.nickname !== undefined)
            m.profile.nickname = patch.nickname;
        if (patch.birthday !== undefined) {
            m.profile.birthday = patch.birthday;
            m.profile.starSign = getStarSign(new Date(`${patch.birthday}T00:00:00`)).name;
            m.rituals.birthdayReminder = patch.birthday;
        }
        if (patch.taboo !== undefined)
            m.profile.taboo = dedupeStrings(patch.taboo);
        this.save(userId, m);
    }
    /** 通用追加：同 key 覆盖 */
    async appendFact(userId, key, value) {
        const m = this.load(userId);
        switch (key) {
            case 'taboo': {
                const arr = Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [];
                m.profile.taboo = dedupeStrings([...m.profile.taboo, ...arr]);
                break;
            }
            case 'custom': {
                const v = typeof value === 'string' ? value : '';
                if (v)
                    m.taste.customs = dedupeStrings([v, ...m.taste.customs]);
                break;
            }
            default: {
                // 其他 key 落到 customs 里作为自由事实
                const v = typeof value === 'string' ? value : JSON.stringify(value);
                if (v)
                    m.taste.customs = dedupeStrings([v, ...m.taste.customs]);
            }
        }
        this.save(userId, m);
    }
    /** 口味画像增量合并 */
    async updateTaste(userId, patch) {
        const m = this.load(userId);
        if (patch.sweetness !== undefined)
            m.taste.sweetness = patch.sweetness;
        if (patch.spicy !== undefined)
            m.taste.spicy = patch.spicy;
        if (patch.temp !== undefined)
            m.taste.temp = patch.temp;
        if (patch.topItems !== undefined) {
            m.taste.topItems = dedupeStrings([...patch.topItems, ...m.taste.topItems]);
        }
        if (patch.customs !== undefined) {
            m.taste.customs = dedupeStrings([...patch.customs, ...m.taste.customs]);
        }
        this.save(userId, m);
    }
    /** 情绪日记：同日同 mood 只保留一条 */
    async addMoodEntry(userId, entry) {
        const m = this.load(userId);
        m.moodDiary = m.moodDiary.filter((e) => !(e.date === entry.date && e.mood === entry.mood));
        m.moodDiary.unshift({
            ...entry,
            trigger: truncate(entry.trigger),
            recommended: entry.recommended ? truncate(entry.recommended) : undefined,
        });
        this.save(userId, m);
    }
    /** 下单后更新习惯：常点单品重排、预算区间滑动、常去门店 */
    async recordOrder(userId, order) {
        const m = this.load(userId);
        m.habits.orders.unshift(order);
        m.habits.orders = m.habits.orders.slice(0, LIMITS.orders);
        // 常点单品按出现次数重排（最近一次权重更高，用前插 + 去重近似实现）
        m.taste.topItems = dedupeStrings([...order.items, ...m.taste.topItems]);
        // 预算区间：与当前值做 7:3 滑动
        const prev = m.habits.budgetRange;
        if (order.total > 0) {
            m.habits.budgetRange = prev
                ? [
                    Math.round((prev[0] * 0.7 + Math.min(prev[0], order.total) * 0.3) * 100) / 100,
                    Math.round((prev[1] * 0.7 + Math.max(prev[1], order.total) * 0.3) * 100) / 100,
                ]
                : [order.total, order.total];
        }
        if (order.store)
            m.habits.usualStore = order.store;
        this.save(userId, m);
    }
    /** 仪式记忆：节气/水逆/生日 */
    async updateRitual(userId, patch) {
        const m = this.load(userId);
        m.rituals = { ...m.rituals, ...patch };
        this.save(userId, m);
    }
    /** 删除单条记忆 */
    async deleteEntry(userId, key) {
        const m = this.load(userId);
        // key 形如 "group.field.value"，但 value 本身可能含点（如日期）或竖线（moodDiary）
        // → 只按前两个点切分，剩下全部归 value
        const firstDot = key.indexOf('.');
        if (firstDot < 0)
            return false;
        const group = key.slice(0, firstDot);
        const rest = key.slice(firstDot + 1);
        // moodDiary 的 key 是 "moodDiary.<date>|<mood>"，整段 rest 就是条目标识，
        // 不能再按点切分（日期里没有点，但保持这个约定更稳）
        if (group === 'moodDiary') {
            if (!rest)
                return false;
            const before = m.moodDiary.length;
            m.moodDiary = m.moodDiary.filter((e) => `${e.date}|${e.mood}` !== rest);
            if (m.moodDiary.length === before)
                return false;
            this.save(userId, m);
            return true;
        }
        const secondDot = rest.indexOf('.');
        const field = secondDot < 0 ? rest : rest.slice(0, secondDot);
        const value = secondDot < 0 ? '' : rest.slice(secondDot + 1);
        let removed = false;
        if (group === 'profile') {
            if (field === 'nickname' && m.profile.nickname !== undefined) {
                delete m.profile.nickname;
                removed = true;
            }
            else if (field === 'birthday' && m.profile.birthday !== undefined) {
                delete m.profile.birthday;
                delete m.profile.starSign;
                removed = true;
            }
            else if (field === 'taboo' && value) {
                const before = m.profile.taboo.length;
                m.profile.taboo = m.profile.taboo.filter((t) => t !== value);
                removed = m.profile.taboo.length !== before;
            }
        }
        else if (group === 'taste') {
            if (field === 'topItems' && value) {
                const before = m.taste.topItems.length;
                m.taste.topItems = m.taste.topItems.filter((t) => t !== value);
                removed = m.taste.topItems.length !== before;
            }
            else if (field === 'customs' && value) {
                const before = m.taste.customs.length;
                m.taste.customs = m.taste.customs.filter((t) => t !== value);
                removed = m.taste.customs.length !== before;
            }
        }
        else if (group === 'habits') {
            if (field === 'usualStore' && m.habits.usualStore !== undefined) {
                delete m.habits.usualStore;
                removed = true;
            }
            else if (field === 'location' && m.habits.location !== undefined) {
                // 删定位要连带清掉 city/keyword，否则门店搜索还会用旧城市
                delete m.habits.location;
                delete m.habits.usualCity;
                removed = true;
            }
            else if (field === 'orders' && value) {
                const before = m.habits.orders.length;
                m.habits.orders = m.habits.orders.filter((o) => o.date !== value);
                removed = m.habits.orders.length !== before;
            }
        }
        else if (group === 'rituals' && field) {
            const rituals = m.rituals;
            if (rituals[field] !== undefined) {
                delete rituals[field];
                removed = true;
            }
        }
        if (removed)
            this.save(userId, m);
        return removed;
    }
    /* ---------------------------------------------------------------- */
    /* 读取                                                              */
    /* ---------------------------------------------------------------- */
    /** 给 LLM 的记忆快照，控制在 2000 字符内 */
    snapshot(userId, now = new Date()) {
        const m = this.load(userId);
        const thisMonth = now.getMonth();
        let birthdayMonth = false;
        if (m.profile.birthday) {
            const bd = new Date(`${m.profile.birthday}T00:00:00`);
            if (!Number.isNaN(bd.getTime()))
                birthdayMonth = bd.getMonth() === thisMonth;
        }
        const tasteTags = [];
        if ((m.taste.sweetness ?? 0) >= 2)
            tasteTags.push('爱甜');
        if ((m.taste.spicy ?? 0) >= 2)
            tasteTags.push('能吃辣');
        if (m.taste.temp?.includes('冰'))
            tasteTags.push('要冰');
        if (m.taste.temp?.includes('热'))
            tasteTags.push('爱热饮');
        tasteTags.push(...m.taste.customs.slice(0, 3));
        const snap = {
            birthdayMonth,
            taboo: m.profile.taboo.slice(0, 5),
            tasteTags: tasteTags.slice(0, 5),
            topItems: m.taste.topItems.slice(0, 3),
            customs: m.taste.customs.slice(0, 3),
            recentMoods: m.moodDiary.slice(0, 3).map((e) => ({ date: e.date, mood: e.mood })),
            retrogradeActive: Boolean(m.rituals.retrograde?.active),
        };
        if (m.profile.nickname)
            snap.nickname = m.profile.nickname;
        if (m.profile.starSign)
            snap.starSign = m.profile.starSign;
        if (m.habits.usualStore)
            snap.usualStore = m.habits.usualStore;
        if (m.habits.usualCity)
            snap.usualCity = m.habits.usualCity;
        if (m.habits.budgetRange)
            snap.budgetRange = m.habits.budgetRange;
        // 门店搜索关键词：优先定位反查出的商圈，其次历史门店名
        const kw = m.habits.location?.district || m.habits.usualStore;
        if (kw)
            snap.usualKeyword = kw;
        return snap;
    }
    /**
     * 记录定位。
     *
     * 坐标本身不能直接给 MCP 用（它只认城市 + 关键词），
     * 所以这里要求调用方一并给出反查后的 city / district。
     */
    async setLocation(userId, loc) {
        const m = this.load(userId);
        // 坐标合法性：纬度 ±90，经度 ±180，且不能是 (0,0)（浏览器定位失败的典型值）
        const valid = Number.isFinite(loc.lat) &&
            Number.isFinite(loc.lng) &&
            Math.abs(loc.lat) <= 90 &&
            Math.abs(loc.lng) <= 180 &&
            !(loc.lat === 0 && loc.lng === 0);
        if (!valid) {
            throw new Error('坐标不合法');
        }
        const location = {
            lat: loc.lat,
            lng: loc.lng,
            source: loc.source ?? 'gps',
            updatedAt: Date.now(),
        };
        if (loc.city) {
            location.city = truncate(loc.city, 40);
            m.habits.usualCity = truncate(loc.city, 40);
        }
        if (loc.district) {
            location.district = truncate(loc.district, 60);
        }
        m.habits.location = location;
        this.save(userId, m);
        log.info(`记录定位 user=${userId} city=${location.city ?? '-'} district=${location.district ?? '-'}`);
    }
    /**
     * 清除定位。
     *
     * 保留 usualStore（那是用户真实点过的店，属行为数据而非定位数据）。
     */
    async clearLocation(userId) {
        const m = this.load(userId);
        delete m.habits.location;
        delete m.habits.usualCity;
        this.save(userId, m);
        log.info(`清除定位 user=${userId}`);
    }
    /** 记忆管理页 5 张卡片 */
    toCards(userId, now = new Date()) {
        const m = this.load(userId);
        const cards = [];
        /* --- 1. 静态档案 --- */
        const profileLines = [];
        const profileEntries = [];
        if (m.profile.nickname) {
            profileLines.push(`昵称：${m.profile.nickname}`);
            profileEntries.push({ key: 'profile.nickname', label: `昵称：${m.profile.nickname}` });
        }
        if (m.profile.birthday) {
            const d = new Date(`${m.profile.birthday}T00:00:00`);
            const bd = !Number.isNaN(d.getTime()) && d.getMonth() === now.getMonth();
            profileLines.push(`${m.profile.starSign ?? ''}${m.profile.birthday ? `（${m.profile.birthday.slice(5).replace('-', '/')}${bd ? ' 生日快到了' : ''}）` : ''}`);
            profileEntries.push({ key: 'profile.birthday', label: `生日：${m.profile.birthday}` });
        }
        if (m.profile.taboo.length > 0) {
            profileLines.push(`忌口：${m.profile.taboo.join('、')}`);
            for (const t of m.profile.taboo) {
                profileEntries.push({ key: `profile.taboo.${t}`, label: `忌口：${t}` });
            }
        }
        cards.push({
            key: 'profile',
            title: '静态档案',
            icon: '👤',
            lines: profileLines.length > 0 ? profileLines : ['还没告诉我你是谁'],
            entries: profileEntries,
        });
        /* --- 2. 口味画像 --- */
        const tasteTags = [];
        if ((m.taste.sweetness ?? 0) >= 2)
            tasteTags.push('爱甜');
        if ((m.taste.spicy ?? 0) >= 2)
            tasteTags.push('能吃辣');
        for (const t of m.taste.temp ?? [])
            tasteTags.push(t === '冰' ? '要冰' : t === '热' ? '爱热饮' : t);
        for (const c of m.taste.customs)
            tasteTags.push(c);
        for (const it of m.taste.topItems.slice(0, 2))
            tasteTags.push(`本命：${it}`);
        cards.push({
            key: 'taste',
            title: '口味画像',
            icon: '🍭',
            lines: tasteTags.length > 0 ? [tasteTags.join(' · ')] : ['还没看出你的口味'],
            entries: [
                ...m.taste.topItems.map((t) => ({ key: `taste.topItems.${t}`, label: `本命：${t}` })),
                ...m.taste.customs.map((c) => ({ key: `taste.customs.${c}`, label: `习惯：${c}` })),
            ],
        });
        /* --- 3. 习惯数据 --- */
        const habitLines = [];
        if (m.habits.usualSlots.length > 0)
            habitLines.push(`常点时段：${m.habits.usualSlots.join('、')}`);
        if (m.habits.budgetRange) {
            habitLines.push(`预算区间：¥${m.habits.budgetRange[0].toFixed(0)}–${m.habits.budgetRange[1].toFixed(0)}`);
        }
        // 定位放在常去门店之前 —— 用户最先想知道"你现在认为我在哪"
        const loc = m.habits.location;
        if (loc) {
            const where = [loc.city, loc.district].filter(Boolean).join(' · ') || '已记录坐标';
            const how = loc.source === 'manual' ? '手填' : '定位';
            habitLines.push(`你在：${where}（${how}）`);
        }
        else if (m.habits.usualCity) {
            habitLines.push(`常去城市：${m.habits.usualCity}`);
        }
        if (m.habits.usualStore)
            habitLines.push(`常去：${m.habits.usualStore}`);
        if (m.habits.orders.length > 0) {
            habitLines.push(`点过 ${m.habits.orders.length} 次`);
        }
        cards.push({
            key: 'habits',
            title: '习惯数据',
            icon: '📅',
            lines: habitLines.length > 0 ? habitLines : ['还没有点单记录'],
            entries: [
                ...(loc
                    ? [
                        {
                            key: 'habits.location',
                            label: `定位：${[loc.city, loc.district].filter(Boolean).join(' · ') || `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`}`,
                        },
                    ]
                    : []),
                ...(m.habits.usualStore
                    ? [{ key: 'habits.usualStore', label: `常去：${m.habits.usualStore}` }]
                    : []),
                ...m.habits.orders
                    .slice(0, 5)
                    .map((o) => ({ key: `habits.orders.${o.date}`, label: `${o.date}：${o.items.join('、')}` })),
            ],
        });
        /* --- 4. 情绪日记 --- */
        const moodLines = m.moodDiary
            .slice(0, 5)
            .map((e) => `${e.date.slice(5).replace('-', '/')} ${e.mood}${e.feedback ? ` · ${e.feedback}` : ''}`);
        cards.push({
            key: 'moodDiary',
            title: '情绪日记',
            icon: '💗',
            lines: moodLines.length > 0 ? moodLines : ['还没记下你的情绪'],
            entries: m.moodDiary
                .slice(0, 10)
                .map((e) => ({ key: `moodDiary.${e.date}|${e.mood}`, label: `${e.date} ${e.mood}` })),
        });
        /* --- 5. 仪式记忆 --- */
        const ritualLines = [];
        if (m.rituals.lastSolarTerm)
            ritualLines.push(`上个节气陪你过的是：${m.rituals.lastSolarTerm}`);
        if (m.rituals.retrograde?.active) {
            ritualLines.push(`水逆第 ${m.rituals.retrograde.dayIndex ?? '?'} 天`);
        }
        if (m.rituals.birthdayReminder) {
            ritualLines.push(`生日：${m.rituals.birthdayReminder.slice(5).replace('-', '/')}`);
        }
        cards.push({
            key: 'rituals',
            title: '仪式记忆',
            icon: '🌙',
            lines: ritualLines.length > 0 ? ritualLines : ['还没到需要仪式感的日子'],
            entries: [
                ...(m.rituals.lastSolarTerm
                    ? [{ key: 'rituals.lastSolarTerm', label: `节气：${m.rituals.lastSolarTerm}` }]
                    : []),
                ...(m.rituals.retrograde?.active
                    ? [{ key: 'rituals.retrograde', label: '水逆记录' }]
                    : []),
            ],
        });
        return cards;
    }
}
function dedupeStrings(arr) {
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        if (typeof raw !== 'string')
            continue;
        const s = raw.trim();
        if (!s)
            continue;
        const k = s.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(s);
    }
    return out;
}
/* ------------------------------------------------------------------ */
/* Store 实现                                                        */
/* ------------------------------------------------------------------ */
/** 内存 store，供单测与访客使用 */
export class InMemoryStore {
    map = new Map();
    load(userId) {
        const v = this.map.get(userId);
        return v ? structuredClone(v) : null;
    }
    save(userId, memory) {
        this.map.set(userId, structuredClone(memory));
    }
    clear() {
        this.map.clear();
    }
}
/* ------------------------------------------------------------------ */
/* 单例                                                              */
/* ------------------------------------------------------------------ */
import { getDb } from '../db/index.js';
/** SQLite 版 store */
export class SqliteStore {
    db;
    constructor(db) {
        this.db = db;
    }
    load(userId) {
        const row = this.db
            .prepare('SELECT data FROM memories WHERE user_id = ?')
            .get(userId);
        if (!row)
            return null;
        try {
            const parsed = JSON.parse(row.data);
            return normalizeMemory(parsed);
        }
        catch {
            log.warn(`记忆数据损坏，重置 user=${userId}`);
            return null;
        }
    }
    save(userId, memory) {
        const now = Date.now();
        this.db
            .prepare(`INSERT INTO memories (user_id, data, version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`)
            .run(userId, JSON.stringify(memory), memory.version, now);
    }
}
function normalizeMemory(m) {
    const base = emptyMemory();
    const out = {
        schemaVersion: m.schemaVersion ?? 1,
        version: m.version ?? 0,
        profile: { ...base.profile, ...(m.profile ?? {}), taboo: m.profile?.taboo ?? [] },
        taste: {
            ...base.taste,
            ...(m.taste ?? {}),
            topItems: m.taste?.topItems ?? [],
            customs: m.taste?.customs ?? [],
        },
        habits: {
            ...base.habits,
            ...(m.habits ?? {}),
            orders: m.habits?.orders ?? [],
            usualSlots: m.habits?.usualSlots ?? [],
        },
        moodDiary: m.moodDiary ?? [],
        rituals: m.rituals ?? {},
        updatedAt: m.updatedAt ?? Date.now(),
    };
    return out;
}
let cachedService = null;
export function getMemoryService() {
    if (!cachedService)
        cachedService = new MemoryService(new SqliteStore(getDb()));
    return cachedService;
}
export function setMemoryServiceForTest(s) {
    cachedService = s;
}
export { LIMITS, truncate, todayIso, dedupeStrings };
//# sourceMappingURL=memory.service.js.map