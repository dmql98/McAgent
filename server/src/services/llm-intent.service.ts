/**
 * 意图解析（LLM 主导）
 *
 * 架构变动（用户指令）：
 *   「直接用 llm 做意图解析。如果是模糊意图 …… 旁路根据用户知识（包括当下时间判断），
 *     判断结论导入主 loop。如果有明确意图 比如我要吃辣，3个人50块这种，
 *     就不需要旁路进行用户知识背景分析，直接第二步」
 *
 * 所以这个文件干三件事：
 *   1. 把用户原话 + 当下时间交给模型，拿到结构化意图；
 *   2. 让模型自己判「这句话够不够清楚」（clarity），而不是规则说了算；
 *   3. 用规则层做**确定性兜底与安全网**，只补不加——
 *      模型漏了忌口是安全事故，规则必须能捞回来。
 *
 * 为什么规则不能退休：
 *   - 忌口/过敏是硬约束，漏一个就是吃出问题，不能赌模型每次都抽到；
 *   - 中文数字（「仨」「两位」）、预算的十几种说法，正则可复现、可单测、零成本；
 *   - 模型超时/挂了，必须有降级路径让用户还能点餐。
 * 所以规则的角色从"决策者"降级成"约束抽取器 + 兜底"，
 * **clarity 的判定权完全交给模型**，这正是不再出现
 * 「帮我点个午餐被反问」那类误判的关键。
 */
import { createLogger } from '../lib/logger.js';
import { chatJson } from './llm.client.js';
import {
  parseIntent as parseByRule,
  __intentInternal as ruleInternal,
} from './intent.service.js';
import type {
  ExplicitConstraints,
  IntentClarity,
  Mood,
  ParsedIntent,
} from '../types/contract.js';

const log = createLogger('llm-intent');

const MOODS: Mood[] = ['烦躁', '疲惫', '低落', '开心', '平淡', '庆祝'];

/* ------------------------------------------------------------------ */
/* Prompt                                                            */
/* ------------------------------------------------------------------ */

const INTENT_SYSTEM_PROMPT = `你是麦当劳点餐 Agent 的意图解析器。你的工作是把用户随口说的一句话，翻译成点餐系统能用的结构化条件。

你不推荐商品、不写文案、不编价格。只做解析。

【最重要的判断：clear 还是 vague】

clear（清楚）—— 用户说了**具体约束**，系统拿这些条件就能直接选品：
  · 口味：「我要吃辣的」「来点清淡的」「想吃甜的」
  · 人数 / 预算：「3 个人 50 块」「两个人 100 以内」「给我一个人吃的」
  · 具体商品：「来个麦辣鸡腿堡」「一包大薯」
  · 忌口：「不吃牛肉」「花生过敏」
  · 明确餐段 + 具体诉求：「午餐来个辣的」

vague（模糊）—— 用户只给了**状态或态度**，没有可以直接选品的约束：
  · 情绪：「很烦」「今天心情不错」「累死了」「emo 了」
  · 只表态要吃饭，没说吃什么：「给我点个午餐」「我饿了」「来一单」「随便」
  · 泛问：「吃点什么好」

⚠️ 关键区别：
  · 「给我点个午餐」→ vague。它只说了"要吃饭"，没说吃什么、几个人、多少钱。
  · 「午餐来个辣的，一个人」→ clear。
  判断标准只有一条：**光靠这句话，能不能直接在菜单上挑出东西**。
  挑不出来就是 vague，别为了显得聪明硬判 clear。

【抽字段】

people：几个人吃。用户没说就填 null，**不要猜**。
  注意「两个汉堡」是两个汉堡，不是两个人；「我和同事」是 2 个人。
budget：总预算上限（元）。「50 块」「100 以内」「预算 80」都是 budget。
  人均的说法（「人均 30」）要乘以人数换算成总额；人数不明就填 null。
taboo：**硬约束** —— 过敏、不吃、忌口。「不吃辣」「花生过敏」「别放洋葱」。
  「不太辣」「少放辣」不算 taboo，进 taste。
taste：口味偏好，软约束。「辣」「清淡」「甜」「冰」「热的」「咖啡」「减肥」「大份」。
mood：情绪，六选一：烦躁 / 疲惫 / 低落 / 开心 / 平淡 / 庆祝。
  负面优先 —— 「累死了终于搞定了」是疲惫，不是开心。
  看不出来填 null，不要硬凑。
fulfillment：自取 / 外送 / 堂食。没提到填 null。
timeHint：时间表述原文，如「明天中午」「今晚」。没说填 null。

【安全】
如果用户表达出明显的自我伤害倾向（想死、撑不下去、活着没意思等），
mood 填「低落」，并在 safety 填 true。这时候不要说教，也不要玩梗。

【输出】
只输出 JSON，不要解释、不要 markdown、不要代码块：

{
  "clarity": "clear" 或 "vague",
  "orderIntent": true 或 false,
  "people": 数字或 null,
  "budget": 数字或 null,
  "taboo": ["..."],
  "taste": ["..."],
  "mood": "烦躁|疲惫|低落|开心|平淡|庆祝|null",
  "fulfillment": "自取|外送|堂食|null",
  "timeHint": "原文或 null",
  "safety": true 或 false,
  "reasoning": "一句话说明你怎么判断的，20 字以内"
}

orderIntent：用户是不是在表达"给我点一单"（哪怕没说吃什么）。「我饿了」「来一单」都是 true；
纯聊天吐槽（「今天好烦」）在没有点餐意思时是 false —— 但这种情况系统会走旁路替他补全，
所以你只要如实判断即可。`;

/* ------------------------------------------------------------------ */
/* 旁路 Prompt                                                       */
/* ------------------------------------------------------------------ */

const CONTEXT_SYSTEM_PROMPT = `你是麦当劳点餐 Agent 的"背景判断器"。

用户刚才说的话没给出能直接选品的条件（比如只说「很烦」「今天心情不错」「给我点个午餐」）。
你的任务是结合**这个人的记忆**和**当下的时间事实**，替他判断这一顿该往哪个方向配。

你**不选商品、不报价格**。你只产出倾向标签，由系统去真实菜单里落地。

【判断原则】
1. 记忆优先于常识。ta 常点麦辣鸡腿堡，就别因为"心烦要吃甜"推一堆甜品。
2. 时间是最硬的约束。早上 8 点推重辣不合理；深夜推大套餐也不合理。
3. 情绪只影响**取向**，不影响分量。烦就给"解压型"（重口、脆的、带辣的），
   累就给"省事型"（熟悉的那套、热的、不用挑的），开心可以试新。
4. 别推忌口里的东西，一个字都别沾。
5. 最近刚吃过的（记忆里的常点/近几天点过的）可以避开，但不用强行避开招牌。

【输出】
只输出 JSON，不要解释、不要 markdown：

{
  "read": "一句话读心，说明你现在理解 ta 是什么状态，25 字以内",
  "mood": "烦躁|疲惫|低落|开心|平淡|庆祝",
  "tasteHints": ["辣", "热的"],
  "people": 数字或 null,
  "budget": 数字或 null,
  "avoid": ["要避开的商品名或品类"],
  "basis": ["判断依据1", "判断依据2"]
}

tasteHints 只能用这些词或其组合：辣、清淡、甜、冰、热、咖啡、减肥、大份、薯条、可乐、解压、省事。
people：能从上下文推出来才填（「我们开会呢」可能是多人，但没把握就填 null）。
  绝对不要因为"一个人吃"就填 1 —— 系统自己有默认值，你填了反而会盖掉真实信息。
budget：只有记忆里有明确预算区间时才填（比如记忆说 ¥30-50，填 50）。
basis：每条都要能指到具体事实（记忆里的一行、或者现在是几点），禁止"因为用户可能需要"这种空话。`;

/* ------------------------------------------------------------------ */
/* 类型                                                              */
/* ------------------------------------------------------------------ */

interface RawIntentResult {
  clarity?: unknown;
  orderIntent?: unknown;
  people?: unknown;
  budget?: unknown;
  taboo?: unknown;
  taste?: unknown;
  mood?: unknown;
  fulfillment?: unknown;
  timeHint?: unknown;
  safety?: unknown;
  reasoning?: unknown;
}

interface RawContextResult {
  read?: unknown;
  mood?: unknown;
  tasteHints?: unknown;
  people?: unknown;
  budget?: unknown;
  avoid?: unknown;
  basis?: unknown;
}

/* ------------------------------------------------------------------ */
/* 解析工具                                                          */
/* ------------------------------------------------------------------ */

function asStringArray(v: unknown, maxLen = 8): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s.length <= 12),
    ),
  ].slice(0, maxLen);
}

function asPositiveNumber(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function asMood(v: unknown): Mood | undefined {
  return typeof v === 'string' && MOODS.includes(v as Mood) ? (v as Mood) : undefined;
}

function asFulfillment(v: unknown): '自取' | '外送' | '堂食' | undefined {
  return v === '自取' || v === '外送' || v === '堂食' ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* 主入口：LLM 意图解析                                              */
/* ------------------------------------------------------------------ */

export interface ParseIntentOptions {
  /** 当下时间，必传 —— 时间进 prompt 是让模型能理解「现在说午饭」这类话 */
  now: Date;
  /** 超时（毫秒），超时就走规则兜底 */
  timeoutMs?: number;
}

/**
 * LLM 主导的意图解析。
 *
 * **永不抛错**：模型失败 → 规则兜底，用户照样能点餐。
 * 但模型成功时，clarity 与 mood 以模型为准，规则只补硬约束。
 */
export async function parseIntentWithLlm(
  message: string,
  opts: ParseIntentOptions,
): Promise<ParsedIntent> {
  const { now, timeoutMs = 9_000 } = opts;
  const rule = parseByRule(message, now);

  const result = await chatJson<RawIntentResult>(
    [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: buildIntentUserPrompt(message, now) },
    ],
    // 这是解析题不是创作题，温度要低
    { temperature: 0.15, maxTokens: 1_000, timeoutMs },
  );

  if (!result) {
    log.warn('LLM 意图解析没拿到有效 JSON，退回规则解析');
    return { ...rule, clarity: ruleVagueToClarity(rule) };
  }

  return mergeIntent(rule, result, message);
}

function buildIntentUserPrompt(message: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]!;
  const hhmm = `${p(now.getHours())}:${p(now.getMinutes())}`;

  return `现在是 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${week} ${hhmm}。

用户说：「${message}」

请解析。只输出 JSON。`;
}

/**
 * 合并 LLM 结果与规则结果。
 *
 * 合并原则：
 *   · clarity / mood / reasoning / orderIntent → **模型说了算**（这是本次重构的核心）
 *   · taboo → **并集**（模型漏了规则补，安全第一）
 *   · taste → 并集
 *   · people / budget → 模型优先，模型没给就用规则的（中文数字规则比模型稳）
 *   · safetyMode → 或运算（任一方命中都开）
 */
function mergeIntent(rule: ParsedIntent, raw: RawIntentResult, message: string): ParsedIntent {
  const llmTaboo = asStringArray(raw.taboo, 6);
  const llmTaste = asStringArray(raw.taste, 8);

  /**
   * 忌口取并集，且做一次"模型说的看起来不像忌口就丢掉"的校验。
   *
   * 模型偶尔会把「辣」这种口味写进 taboo（用户说"想吃辣"它写成不吃辣），
   * 那会把整个辣味菜单全过滤掉 —— 比漏判更糟。
   * 这里用规则结果反查：规则没识别出这个忌口、且原文里没有否定词搭配，
   * 就当模型写错了，丢掉。
   */
  const ruleText = rule.explicit.taboo.join('|');
  const safeLlmTaboo = llmTaboo.filter((t) => {
    if (rule.explicit.taboo.some((r) => r.includes(t) || t.includes(r))) return true;
    // 原文里必须真的存在"不吃/过敏/忌口/别放"这类词，才采信模型新提出的忌口
    const negRe = new RegExp(
      `(不吃|不能吃|不要|别放|别加|忌口|过敏|讨厌|受不了|免|去)\\s*[^，。,.!！?？]{0,4}${escapeRe(t)}`,
    );
    return negRe.test(message.replace(/\s+/g, ''));
  });

  const taboo = [...new Set([...rule.explicit.taboo, ...safeLlmTaboo])];
  const dropped = llmTaboo.filter((t) => !safeLlmTaboo.includes(t));
  if (dropped.length > 0) {
    log.warn(`模型给的忌口「${dropped.join('、')}」原文里找不到依据，已丢弃`);
  }

  const taste = [...new Set([...rule.explicit.taste, ...llmTaste])].filter(
    // 已经进了硬忌口的，不要再出现在口味偏好里
    (t) => !taboo.some((b) => b.includes(t) || t.includes(b)),
  );

  const explicit: ExplicitConstraints = { taboo, taste };

  const llmPeople = asPositiveNumber(raw.people, 1, 30);
  const llmBudget = asPositiveNumber(raw.budget, 1, 10_000);

  // 人数/预算：模型优先，模型没给用规则的（规则对中文数字更稳）
  const people = llmPeople ?? rule.explicit.people;
  const budget = llmBudget ?? rule.explicit.budget;
  if (people !== undefined) explicit.people = Math.round(people);
  if (budget !== undefined) explicit.budget = Math.round(budget * 100) / 100;
  const fulfillment = asFulfillment(raw.fulfillment) ?? rule.explicit.fulfillment;
  if (fulfillment) explicit.fulfillment = fulfillment;

  if (rule.explicit.timeHint) explicit.timeHint = rule.explicit.timeHint;
  if (rule.explicit.targetDate) explicit.targetDate = rule.explicit.targetDate;

  const llmMood = asMood(raw.mood);
  const mood = llmMood ?? rule.mood;
  const safetyMode = raw.safety === true || rule.safetyMode;

  /* ---- clarity：模型说了算 ---- */
  let clarity: IntentClarity;
  if (raw.clarity === 'clear' || raw.clarity === 'vague') {
    clarity = raw.clarity;
  } else {
    clarity = ruleVagueToClarity(rule);
  }

  /**
   * 硬约束存在 → 无论模型说什么都是 clear。
   *
   * 这条防线是给"模型手滑"兜底的：用户明明写了「花生过敏」，
   * 模型判 vague 就会白跑一趟旁路，还可能在旁路里把忌口弄丢。
   * 有明确约束就直接进选品，这是我们能百分百确定的。
   */
  if (taboo.length > 0 || explicit.budget !== undefined || explicit.people !== undefined) {
    clarity = 'clear';
  }

  const orderIntent = raw.orderIntent === true || rule.orderIntent;

  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 60) : undefined;

  log.info(
    `意图 ${clarity} mood=${mood ?? '无'} people=${explicit.people ?? '-'} ` +
      `budget=${explicit.budget ?? '-'} taboo=[${taboo.join('、')}] taste=[${taste.join('、')}]` +
      (reasoning ? ` | ${reasoning}` : ''),
  );

  return {
    explicit,
    mood,
    moodConfidence: llmMood ? 0.85 : rule.moodConfidence,
    // 新架构下模糊 **不等于** 要反问 —— 模糊走旁路。反问只在旁路也失手时才发生。
    needsClarify: false,
    safetyMode,
    source: 'llm',
    raw: message,
    clarity,
    orderIntent,
    ...(reasoning ? { reasoning } : {}),
  };
}

/** 规则兜底时把旧的 hasExplicit 逻辑翻译成 clarity */
function ruleVagueToClarity(rule: ParsedIntent): IntentClarity {
  const e = rule.explicit;
  const hasHard =
    e.taboo.length > 0 || e.people !== undefined || e.budget !== undefined || e.taste.length > 0;
  if (hasHard) return 'clear';
  // 规则没有任何约束 → 按模糊处理，让旁路去补
  return 'vague';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* 旁路：用户知识 + 时间背景                                          */
/* ------------------------------------------------------------------ */

export interface AnalyzeContextInput {
  message: string;
  now: Date;
  /** 时间事实（时段/星期/节气），由编排器算好传进来，保证与主链路一致 */
  timeFacts: {
    slot: string;
    week: string;
    solarTerm: string;
    solarTermImagery: string;
    retrograde: string | null;
  };
  /** 记忆快照，可为空（访客） */
  snapshot: {
    nickname?: string;
    taboo: string[];
    tasteTags: string[];
    topItems: string[];
    customs: string[];
    recentMoods: { date: string; mood: string }[];
    budgetRange?: [number, number];
    usualStore?: string;
  } | null;
  timeoutMs?: number;
}

/**
 * 旁路判断：模糊意图才调用。
 *
 * **永不抛错**。拿不到结论就返回 ran=false，
 * 主 loop 用"1 人 + 无倾向"的默认值继续跑 —— 用户至少能拿到一份菜单。
 */
export async function analyzeContext(input: AnalyzeContextInput): Promise<{
  ran: boolean;
  read: string;
  mood?: Mood;
  tasteHints: string[];
  people?: number;
  budget?: number;
  avoid: string[];
  basis: string[];
}> {
  const empty = { ran: false, read: '', tasteHints: [] as string[], avoid: [] as string[], basis: [] as string[] };

  try {
    const result = await chatJson<RawContextResult>(
      [
        { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
        { role: 'user', content: buildContextUserPrompt(input) },
      ],
      { temperature: 0.5, maxTokens: 900, timeoutMs: input.timeoutMs ?? 9_000 },
    );

    if (!result) {
      log.warn('旁路判断没拿到有效 JSON，主 loop 用默认值继续');
      return empty;
    }

    const read = typeof result.read === 'string' ? result.read.slice(0, 60) : '';
    const tasteHints = asStringArray(result.tasteHints, 5);
    const mood = asMood(result.mood);
    const people = asPositiveNumber(result.people, 1, 30);
    const budget = asPositiveNumber(result.budget, 10, 10_000);
    const avoid = asStringArray(result.avoid, 4);
    const basis = asStringArray(result.basis, 5);

    log.info(
      `旁路判断：${read || '(无)'} | taste=[${tasteHints.join('、')}] ` +
        `people=${people ?? '-'} budget=${budget ?? '-'}` +
        (basis.length > 0 ? ` | 依据：${basis.join('；')}` : ''),
    );

    return {
      ran: true,
      read,
      ...(mood ? { mood } : {}),
      tasteHints,
      ...(people !== undefined ? { people: Math.round(people) } : {}),
      ...(budget !== undefined ? { budget: Math.round(budget) } : {}),
      avoid,
      basis,
    };
  } catch (err) {
    log.warn(`旁路判断异常（已忽略）：${(err as Error).message}`);
    return empty;
  }
}

function buildContextUserPrompt(input: AnalyzeContextInput): string {
  const { message, now, timeFacts, snapshot } = input;
  const p = (n: number) => String(n).padStart(2, '0');

  const memLines: string[] = [];
  if (snapshot) {
    if (snapshot.nickname) memLines.push(`昵称：${snapshot.nickname}`);
    if (snapshot.taboo.length > 0) memLines.push(`忌口/过敏（绝对避开）：${snapshot.taboo.join('、')}`);
    if (snapshot.tasteTags.length > 0) memLines.push(`口味标签：${snapshot.tasteTags.join('、')}`);
    if (snapshot.topItems.length > 0) memLines.push(`常点单品：${snapshot.topItems.join('、')}`);
    if (snapshot.customs.length > 0) memLines.push(`特制习惯：${snapshot.customs.join('、')}`);
    if (snapshot.budgetRange) {
      memLines.push(`历史预算区间：¥${snapshot.budgetRange[0]}–${snapshot.budgetRange[1]}`);
    }
    if (snapshot.recentMoods.length > 0) {
      memLines.push(
        `最近情绪：${snapshot.recentMoods.map((m) => `${m.date} ${m.mood}`).join('；')}`,
      );
    }
    if (snapshot.usualStore) memLines.push(`常去门店：${snapshot.usualStore}`);
  }

  const timeLines = [
    `现在是 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${timeFacts.week} ` +
      `${p(now.getHours())}:${p(now.getMinutes())}`,
    `时段：${timeFacts.slot}`,
    `节气：${timeFacts.solarTerm}（${timeFacts.solarTermImagery}）`,
  ];
  if (timeFacts.retrograde) timeLines.push(`水逆：${timeFacts.retrograde}`);

  return `【用户记忆】
${memLines.length > 0 ? memLines.join('\n') : '（这是个新用户，你还不了解 ta）'}

【当下时间】
${timeLines.join('\n')}

【用户刚说的话】
「${message}」

ta 这句话没给出能直接选品的条件。请结合上面的事实，判断这一顿该往哪个方向配。
只输出 JSON。`;
}

/* ------------------------------------------------------------------ */
/* 结论 → 约束                                                       */
/* ------------------------------------------------------------------ */

/**
 * 旁路的口味倾向 → 选品引擎真正认识的标签。
 *
 * 为什么必须收敛：模型很爱输出「解压」「省事」「暖胃」这种**语义标签**，
 * 听着对，但 selector 的 matchTasteTag 只认固定词表（甜/辣/冰/热/咸/清淡/
 * 咖啡/可乐/薯条/大份/减肥…）。对不上的标签不会报错，只是**静默失效** ——
 * 等于模型说了半天，选品一个字都没听进去。
 * 所以在进入 intent 之前做一次映射，把模型的语言翻译成引擎的语言。
 */
const TASTE_CANON: Record<string, string[]> = {
  解压: ['辣', '大份'],
  发泄: ['辣'],
  重口: ['辣'],
  爽: ['辣'],
  省事: ['大份'],
  熟悉: [],
  暖胃: ['热'],
  暖和: ['热'],
  热乎: ['热'],
  提神: ['咖啡'],
  甜食: ['甜'],
  清凉: ['冰'],
  轻食: ['清淡'],
  健康: ['清淡'],
};

/** 引擎认识的标签全集，用于过滤 */
const VALID_TASTE = new Set([
  '甜', '辣', '冰', '热', '咸', '清淡', '健康', '咖啡', '可乐', '薯条',
  '大份', '小份', '减肥', '牛肉', '鸡肉', '鱼', '甜品',
]);

/**
 * 把模型的倾向词规范化成引擎认得的标签。
 * 认得就留，能映射就映射，映射不出来就丢 —— 留着也没用，反而会误导后续判断。
 */
function canonicalizeTaste(hints: string[]): string[] {
  const out: string[] = [];
  for (const h of hints) {
    if (VALID_TASTE.has(h)) {
      out.push(h);
      continue;
    }
    const mapped = TASTE_CANON[h];
    if (mapped) out.push(...mapped);
  }
  return [...new Set(out)];
}

/**
 * 把旁路结论**并入**意图，形成主 loop 实际使用的意图。
 *
 * 合并优先级：**用户明说的 > 旁路推断的**。
 * 用户说了 3 个人就绝不能用旁路猜的 1 人；
 * 用户说了 50 块就绝不能用记忆里的区间上限。这是"推断只填空、不覆盖"的原则。
 *
 * ⚠️ 有两个字段旁路**永远不能填**：`explicit.budget` 和 `explicit.people` 里的"伪造"。
 * 说明如下（这是踩过的坑）：
 *
 *   旁路从记忆里读到 `budgetRange: [46.28, 87.5]`，很自然会填 budget=87.5。
 *   但 `explicit.budget` 的语义是"**用户说了这个数**" —— 它会
 *   ① 让回复卡片显示一条预算进度条、② 触发超预算重选逻辑、③ 落进记忆。
 *   用户从没说过 87.5，却被系统按这个数当墙，而且模型可能每次推出不同的数
 *   （实测有 87、88、87.5 三个版本），导致同一句话每次得到的菜单都不一样。
 *   所以旁路推的预算只能进 `softBudget`（软目标，选品偏向用），不进 `explicit`。
 *
 *   人数不同：`explicit.people` 影响的是"配几份"，旁路猜 2 人配 2 份，
 *   猜错了用户看得见也能改（改数量比改预算直观得多），而且"没说人数"本来
 *   就要兜成 1 人 —— 有个更接近真实的猜测比硬性 1 人更好。所以人数允许填。
 */
export function applyContextToIntent(
  intent: ParsedIntent,
  ctx: Awaited<ReturnType<typeof analyzeContext>>,
): ParsedIntent {
  if (!ctx.ran) return intent;

  const explicit: ExplicitConstraints = {
    ...intent.explicit,
    taboo: [...intent.explicit.taboo],
    taste: [...intent.explicit.taste],
  };

  // 口味倾向：先规范化成引擎认得的标签，再并集
  const canonical = canonicalizeTaste(ctx.tasteHints);
  const merged = [...new Set([...explicit.taste, ...canonical])];
  explicit.taste = merged.filter(
    (t) => !explicit.taboo.some((b) => b.includes(t) || t.includes(b)),
  );

  /**
   * 人数：只填空。
   * 用户没说 → 用旁路估的（比硬性 1 人更贴实际）；用户说了 → 一个字都不改。
   */
  if (explicit.people === undefined && ctx.people !== undefined) explicit.people = ctx.people;

  /**
   * 预算：**用户说了就不动，用户没说也不进 explicit** —— 走 softBudget。
   * 理由见上面的长注释。用户明说的预算优先级最高，旁路不参与。
   */
  const softBudget =
    explicit.budget === undefined && ctx.budget !== undefined ? ctx.budget : undefined;

  return {
    ...intent,
    explicit,
    // 情绪：意图解析没结论时用旁路的
    mood: intent.mood ?? ctx.mood ?? null,
    moodConfidence: intent.mood ? intent.moodConfidence : ctx.mood ? 0.6 : intent.moodConfidence,
    ...(softBudget !== undefined ? { softBudget } : {}),
    ...(ctx.read ? { contextRead: ctx.read } : {}),
    ...(ctx.avoid.length > 0 ? { contextAvoid: ctx.avoid } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 供测试用                                                          */
/* ------------------------------------------------------------------ */

export const __llmIntentInternal = {
  mergeIntent,
  ruleVagueToClarity,
  applyContextToIntent,
  asStringArray,
  asPositiveNumber,
  /** 规则层的原样能力，供降级路径复用 */
  ruleInternal,
};
