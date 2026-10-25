/**
 * 出单判断（主 loop 第 ③ 步）
 *
 * 定位：选品仍由 selector.service 的确定性规则产出（可复现、可测），
 * 这一层在**出结果之后**、**算价之前**做一次判断：
 *   ① 这份菜单本身像不像人点的；
 *   ② 这份菜单**放进用户已有的购物车**之后，整辆车还像不像人点的。
 *
 * 为什么要把购物车一起给模型看（本次架构调整新增）：
 * 早期只校验"这一单"内部是否自洽，于是出现过这种场面 ——
 * 车里已经有一份麦辣鸡腿堡套餐，用户又说「想吃辣的」，
 * 系统配了一份同样带麦辣鸡腿堡的菜单**整体替换**购物车；
 * 或者用户说「再加点」，系统配的单里有他已经有的东西。
 * 单看这一单没毛病，放进车里就是重复。所以判断必须带着车一起做。
 *
 * 硬边界（架构 §1 决策②的延伸）：
 *   - 模型**不产出菜单**，只产出"哪里不对 + 怎么改"的结构化建议；
 *   - 建议必须落到白名单动作上（remove / dropDrink / dropDessert / mergeMain），
 *     由本地代码执行，绝不接受模型给的商品 id 或价格；
 *   - 模型不可用 / 超时 / 返回乱码 → 一律按"没发现问题"处理，绝不影响主链路。
 */
import { createLogger } from '../lib/logger.js';
import { chatJson } from './llm.client.js';
import type { MenuItem } from '../types/contract.js';

const log = createLogger('menu-review');

/** 复核后可执行的**本地**纠偏动作，白名单，模型只能选这些 */
export type ReviewFix =
  | 'remove_duplicate_drink'
  | 'remove_extra_dessert'
  | 'remove_extra_main'
  /** 车里已经有同名/同类的东西，这一项别加了 */
  | 'remove_cart_duplicate'
  | 'none';

/** 一份菜单项在购物车里的投影（只给模型看名字和数量，不给 id 和价） */
export interface CartLineView {
  name: string;
  qty: number;
}

export interface ReviewIssue {
  /** 问题类型，白名单 */
  kind:
    | 'too_much_food'
    | 'duplicate_drink'
    | 'duplicate_main'
    | 'too_many_desserts'
    | 'illogical'
    /** 与购物车已有内容重复 */
    | 'cart_duplicate'
    /** 与购物车合并后总量超了（人不够吃这么多 / 预算要爆） */
    | 'cart_overload'
    | 'none';
  /** 一句话说明，给日志和（可选）前端提示用 */
  detail: string;
  /** 建议执行的纠偏动作 */
  fix: ReviewFix;
  /** 要动的那一项的下标（0-based，指向传入的 menu） */
  index?: number;
  /** 建议删掉的份数，默认全删那一项 */
  qty?: number;
}

export interface ReviewResult {
  /** 是否认为合理 */
  ok: boolean;
  issues: ReviewIssue[];
  /** 是否真的调用了模型（false = 跳过/失败，按合理处理） */
  checked: boolean;
  /**
   * 问题严重程度 —— 决定处理方式：
   *   none  没问题
   *   minor 小毛病，本地做减法就够（多一杯饮料、多一份甜品）
   *   major 配得不像话，减法救不回来，**要整单重配**
   */
  severity: 'none' | 'minor' | 'major';
  /** 模型的一句话总评，便于开发时观察 */
  verdict?: string;
  /** 建议重配时要避开的商品名（只在 major 时有值） */
  avoidNames?: string[];
}

export interface ReviewInput {
  /** 用户原话 */
  message: string;
  /** 实际参与选品的人数（已含"没说就按 1 个人"的兜底） */
  people: number;
  /** 用户是否明说过人数 —— 决定措辞严厉程度 */
  peopleExplicit: boolean;
  budget?: number;
  taboo: string[];
  taste: string[];
  menu: MenuItem[];
  /**
   * 购物车当前内容 —— 即"购物车结论"。
   *
   * 这里的语义很关键：主 loop 出单后是**整体替换**购物车，
   * 所以车里的东西代表的是**用户上一轮拿到、并且可能手动调过的结果**。
   * 它有两条用途：
   *
   *   1. 用户手动删过的东西，这单不要再配回来。
   *      典型场景：用户删掉了薯条，下一轮说「来点辣的」，
   *      系统重配一单又把薯条塞回去 —— 用户会觉得"我说的话你根本没记住"。
   *      车是唯一能反映"用户编辑痕迹"的信号，必须带上。
   *
   *   2. 车里保留的核心单品，这单不该与之冲突（比如已经有一份套餐，
   *      这单配了两份主食）。
   *
   * 注意**不是**让模型"去重" —— 替换语义下没有跨车重复这回事。
   * 这一点必须在 prompt 里讲清楚，否则模型会一本正经地建议删掉
   * "车里已经有的东西"，而那东西本来就要被替换掉。
   */
  cart?: CartLineView[];
  /** 车上合计金额（真实值，不是估算），帮助判断合并后会不会爆预算 */
  cartTotal?: number;
  /** 旁路给出的判断结论摘要，让模型知道系统"为什么这么配" */
  contextRead?: string;
  /** 旁路判定该避开的商品/品类 */
  avoidFromContext?: string[];
  /**
   * 本单与购物车的关系。
   *
   *   'replace'（默认）：整单替换。查"有没有把用户删掉的东西配回来"。
   *   'merge'：并入。查"跨车重复"和"合并后超量"。
   */
  cartRelation?: 'replace' | 'merge';
}

const REVIEW_SYSTEM_PROMPT = `你是麦当劳点餐的"常识校对员"。你的唯一任务是判断一份已经配好的菜单**像不像人真正会点的**。

你不负责推荐、不负责改价、不负责换商品。你只输出判断结论。

【重点检查】
1. 主食份数是否超出人数。一个人吃的主食不要超过 1 份。
   ⚠️ **多人餐按名字里的人数计份**：「三人餐」算 3 份主食，「双人餐」算 2 份，
   不是「一份套餐算 1 份」。一份三人餐就是三个人的饭，不需要再配单人套餐。
2. 饮料是否重复。套餐里自带饮料时，不要再单独点一杯同类饮料。
3. 甜品是否过量。甜品是"加一口"，不要让甜品份数超过人数。
4. 主食是否重复堆叠。同一个"堡"既以单品出现又以套餐形式出现，就是重复。
   同一批人既有「三人餐」又有「单人套餐 ×3」也是重复 —— 那是 6 份饭给 3 个人。
5. 有没有明显不合常理的东西（比如一个人配 4 个主食）。

【要删的时候删哪个 —— 这条最容易搞错】
发现"总量超了"时，**要删的是重复堆叠出来的那一批**，不是唯一的多人餐。
- 3 个人收到「三人餐 ×1 + 单人套餐 ×3」：删掉 3 份单人套餐，保留三人餐。
  反过来删三人餐、留下 3 份单人套餐，虽然"份数对了"，
  但用户本来想点三人餐，你把他要的那个删了 —— 这是错的方向。
- 判断顺序：先看有没有多人餐（名字带 N 人餐）；
  有多人餐且它能吃饱，多出来的单人餐就是重复，删单人餐。

【如果给了"购物车现在的内容"】
那是用户**上一轮拿到的单**，可能被 ta 手动改过。这时额外检查：

（A）替换模式（说明这一单会整份替换掉车里的东西）
6. 用户手动删掉的东西，这一单**不要再配回来**。
   车里有 3 样，明显比上一单少一样 —— 少了的那样就是用户主动删的，
   这单再配回来，用户会觉得"我说的话你根本没记住"。
   判断方法是拿车里的东西和"这一单"对比：如果这一单里出现了
   某个**本该有但车里没有**的常见搭配（比如上一单有薯条、这单又有薯条），
   而看不出用户想要它 —— 这就是疑难，宁可放过。
   **只有在你能明确说出"用户删掉了 X"时才报。**

（B）并入模式
6. 车里已经有的东西，这一单不要再出现一遍。
7. 合并后的总量会不会超：人数够不够吃完，合计金额会不会超出预算。
   车里的东西**不是你能动的**，你只能建议删"这一单"里的项。

【不要管的】
- 价格高低、预算是否用得满 —— 那是系统算好的，不用你判断。
- 口味是否合适 —— 用户偏好已处理。
- 具体该换成什么商品 —— 你**没有**推荐权。
- **不要建议删掉"购物车里已有的东西"** —— 你只能动这一单的序号。

【输出格式 —— 必须严格遵守】
{"ok": true 或 false, "severity": "none" | "minor" | "major", "verdict": "一句话总评，20 字以内", "remove": [要删掉的序号], "avoid": ["要换掉的商品名"]}

字段说明：
- "remove"：只填**菜单里已有的序号**（从 0 开始，就是你看到的那些数字）。要删几项就填几个序号；不删就填空数组 []。
  不要填商品名、不要填新序号、不要写解释。例：[1, 3]
- "avoid"：只在 severity 是 "major" 时填。从菜单里**原样抄** 1-2 个最该被换掉的商品名。
  不要写"避免同时点多个同类汉堡"这种话，必须是菜单上真实存在的名字。
  例：["汉堡包", "鱼牛汉堡随心选单人餐"]
- "severity"：
  "none" = 没问题；
  "minor" = 只是多了一点，把 remove 里的删掉就正常；
  "major" = 整份菜单骨架不对（人数和主食严重不匹配、同一款堡既单点又出现在套餐里），
            删一样救不回来，必须重配 —— 这时 avoid 必须填。

【示例】
菜单：
0. 麦辣鸡腿汉堡 ×1  ¥25.5
1. 汉堡包 ×1  ¥15
2. 鱼牛汉堡随心选单人餐 ×2  ¥76.8
3. 草莓新地 ×1  ¥12
4. 朱古力新地 ×1  ¥12
用户 1 个人。
输出：
{"ok": false, "severity": "major", "verdict": "一个人四个主食，明显过量", "remove": [4], "avoid": ["鱼牛汉堡随心选单人餐", "汉堡包"]}

带购物车的例子：
购物车已有：麦辣鸡腿堡套餐 ×1
这一单：0. 麦辣鸡腿汉堡 ×1  ¥25.5 / 1. 中薯条 ×1  ¥12
用户 1 个人，说「再加点」。
输出：
{"ok": false, "severity": "minor", "verdict": "车里已有同款汉堡，重复了", "remove": [0], "avoid": []}

正常情况输出：
{"ok": true, "severity": "none", "verdict": "合理", "remove": [], "avoid": []}

只输出 JSON，不要任何其他文字、不要解释、不要 markdown。
宁可放过，不要误杀 —— 只有你确信"人看到会皱眉"才报问题。`;

/**
 * 把菜单渲染成模型能读的一行行文本。
 *
 * 只给必要信息：序号、名字、份数、价格。
 * 不给 productId —— 从根上避免模型"顺手"返回商品编码。
 */
function describeMenu(menu: MenuItem[]): string {
  return menu
    .map((m, i) => {
      const qty = (m.spec ?? '').match(/×\s*(\d+)/)?.[1] ?? '1';
      return `${i}. ${m.name} ×${qty}  ¥${m.price}`;
    })
    .join('\n');
}

function buildUserPrompt(input: ReviewInput): string {
  const who = input.peopleExplicit
    ? `用户明确说了是 ${input.people} 个人。`
    : `用户没说人数，系统按 **1 个人** 配的（这是默认值，请按 1 人校验）。`;

  const constraints: string[] = [who];
  if (input.budget !== undefined) constraints.push(`预算 ¥${input.budget}`);
  if (input.taboo.length > 0) constraints.push(`忌口 ${input.taboo.join('、')}`);
  if (input.taste.length > 0) constraints.push(`想吃 ${input.taste.join('、')}`);

  const sections: string[] = [
    `用户原话：「${input.message}」`,
    `条件：${constraints.join(' / ')}`,
  ];

  /**
   * 购物车上下文：这段文案必须**把语义讲清楚**。
   *
   * 踩过的坑：早期只说"购物车已经有 X"，模型就去建议删掉车里 X ——
   * 而本地白名单只认这一单的下标，越界直接忽略，
   * 于是建议变成无效动作，白跑一趟还多花几百毫秒。
   */
  if (input.cart && input.cart.length > 0) {
    const cartLines = input.cart.map((c) => `- ${c.name} ×${c.qty}`).join('\n');
    const totalLine =
      input.cartTotal !== undefined && input.cartTotal > 0 ? `\n车上合计 ¥${input.cartTotal}` : '';

    const mode = input.cartRelation ?? 'replace';
    const modeNote =
      mode === 'merge'
        ? '这一单是要**并进**上面的车的：检查跨车重复，以及合并后总量是否超。'
        : '这一单会**整份替换**上面的车（车里的内容将被清掉）。\n' +
          '所以不用管"跨车重复"，重点是：用户手动删过的东西别配回来。';

    sections.push(
      `购物车现在的内容（**这些不是你能动的，你只能建议删下面这一单里的项**）：\n${cartLines}${totalLine}\n\n${modeNote}`,
    );
  }

  if (input.contextRead) {
    sections.push(`系统对这一单的判断依据：${input.contextRead}`);
  }
  if (input.avoidFromContext && input.avoidFromContext.length > 0) {
    sections.push(`系统已知应该避开的：${input.avoidFromContext.join('、')}`);
  }

  sections.push(
    `系统配好的菜单（序号. 商品 ×份数 小计）：\n${describeMenu(input.menu)}`,
    '请判断这份菜单像不像人会点的。只输出 JSON。',
  );

  return sections.join('\n\n');
}

/**
 * 把模型返回的 remove 序号收窄成可信的 ReviewIssue。
 *
 * 模型现在只被要求给出序号（[1,3] 这种），比让它输出带 kind/fix 的对象
 * 稳定得多 —— 早期用嵌套对象，模型经常把 issues 写成字符串数组、
 * 把 fix 字段漏掉，结果整条复核对不上任何动作，等于白跑。
 *
 * 这里只做**序号 → 整项删除**的映射：删掉用户多点的东西，
 * 永远比"改写份数"更安全（不会出现 ×0.5 这种怪东西）。
 */
function normalizeIssues(raw: unknown, menuLen: number): ReviewIssue[] {
  if (!Array.isArray(raw)) return [];

  const out: ReviewIssue[] = [];
  const seen = new Set<number>();

  for (const v of raw) {
    // 只接受数字序号；字符串、对象一律忽略
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n)) continue;
    if (n < 0 || n >= menuLen) continue; // 越界绝不误删
    if (seen.has(n)) continue;

    seen.add(n);
    out.push({
      kind: 'too_much_food',
      detail: '复核建议删掉',
      fix: 'remove_extra_main',
      index: n,
    });
  }

  return out;
}

/**
 * 复核一份菜单。
 *
 * **永不抛错**：任何异常都退化成「没发现问题」。
 * 复核是锦上添花，不能因为它让用户拿不到菜单。
 */
/**
 * 确定性结构体检（**不调模型**，纯规则）。
 *
 * 为什么在模型之外还要这一层：
 *   复核 prompt 已经写了"多人餐按名字人数计份"，但那是**请求模型理解**，
 *   不是**保证**。LLM 可能超时、返回乱码、或者干脆判断成"合理"——
 *   而这几种情况下复核都退化成"没发现问题"，菜单原样发给用户。
 *   人数档位对不对是**算术问题**，算术不该交给概率模型。
 *
 * 只查一件事：**一份够吃 N 人的多人餐已经在菜单里，却还配了能独立成餐的
 * 单人套餐** —— 这是最典型、也最伤信任的结构错误（3 人收到 6 人份）。
 *
 * 安全边界（宁可放过，不可误杀）：
 *   · 只在"多人餐覆盖了全部人数"时才判重复，覆盖率不足就别动；
 *   · 只删单人**套餐**，不碰单品汉堡（用户可能就想加个堡换口味）；
 *   · 删完必须仍然够吃，否则整体放弃；
 *   · 只做减法，不新增、不改价。
 */
export function structuralCheck(
  menu: MenuItem[],
  people: number,
): { issues: ReviewIssue[]; note?: string } {
  if (menu.length === 0 || people < 2) return { issues: [] };

  const qtyOfM = (m: MenuItem): number =>
    parseInt((m.spec ?? '').match(/×\s*(\d+)/)?.[1] ?? '1', 10) || 1;

  /** 名字里的人数档位：三人餐→3，双人餐→2；没写人数返回 1 */
  const servesOfName = (name: string): number => {
    if (/三人|3\s*人/.test(name)) return 3;
    if (/四人|4\s*人/.test(name)) return 4;
    if (/双人|两人|2\s*人/.test(name)) return 2;
    if (/多人|全家/.test(name)) return 4;
    return 1;
  };
  const isComboName = (name: string): boolean =>
    /套餐|件套|单人餐|双人餐|多人餐|分享餐|随心选|随心配|组合|拼盘/.test(name) ||
    /[一二三四五六两\d]\s*人餐/.test(name);

  let multiFeed = 0;
  const multiIdx: number[] = [];
  const singleIdx: number[] = [];

  menu.forEach((m, i) => {
    const serves = servesOfName(m.name);
    const qty = qtyOfM(m);
    if (serves >= 2) {
      multiFeed += serves * qty;
      multiIdx.push(i);
    } else if (isComboName(m.name)) {
      singleIdx.push(i);
    }
  });

  // 没有多人餐，或多人餐本身不够吃 → 单人餐是必要的，不能删
  if (multiIdx.length === 0 || multiFeed < people) return { issues: [] };
  if (singleIdx.length === 0) return { issues: [] };

  /**
   * 多人餐已经够 N 个人吃，还配了单人套餐 → 重复。
   * 删掉全部单人套餐后仍要够吃，否则不动（说明多人餐其实不够，是它在补缺口）。
   */
  const afterFeed = multiFeed;
  if (afterFeed < people) return { issues: [] };

  const issues: ReviewIssue[] = singleIdx.map((i) => ({
    kind: 'duplicate_main' as const,
    detail: `已有足够 ${people} 人吃的多人餐，这份单人套餐是重复的`,
    fix: 'remove_extra_main' as const,
    index: i,
  }));

  return {
    issues,
    note: `多人餐已覆盖 ${multiFeed} 人份，单人套餐 ${singleIdx.length} 项重复`,
  };
}

export async function reviewMenu(input: ReviewInput, timeoutMs = 12_000): Promise<ReviewResult> {
  if (input.menu.length === 0) {
    return { ok: true, issues: [], checked: false, severity: 'none' };
  }

  /**
   * 先跑确定性体检。
   *
   * 命中就不必再问模型了 —— 这是算术问题，规则能给出的结论比模型更可靠，
   * 而且省一次几百毫秒到几秒的调用，用户在等。
   */
  const structural = structuralCheck(input.menu, input.people);
  if (structural.issues.length > 0) {
    log.info(`结构体检发现问题（跳过模型复核）：${structural.note}`);
    return {
      ok: false,
      issues: structural.issues,
      checked: false,
      severity: 'minor',
      verdict: structural.note ?? '主食重复',
    };
  }

  try {
    /**
     * maxTokens 给足 2000。
     *
     * 踩过两次坑：
     *   第一次给 500，issues 数组还没写完就被截断，拿到半截 JSON 解析失败
     *   → 一律按"没问题"处理 → 复核等于白跑。
     *   第二次提到 1200，仍然被吃满（实测 prompt 1392 + completion 1200），
     *   因为推理模型的思考过程也算在 completion 里。
     * 复核是最后一道闸门，宁可贵一点也不能哑火。
     */
    const result = await chatJson<{
      ok?: boolean;
      severity?: string;
      verdict?: string;
      remove?: unknown;
      avoid?: unknown;
    }>(
      [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      // temperature 低：这是判断题，不是创作题
      { temperature: 0.1, maxTokens: 2_000, timeoutMs },
    );

    if (!result) {
      log.warn('复核未拿到有效 JSON，按"没发现问题"处理');
      return { ok: true, issues: [], checked: false, severity: 'none' };
    }

    const issues = normalizeIssues(result.remove, input.menu.length);
    const verdict = typeof result.verdict === 'string' ? result.verdict.slice(0, 60) : undefined;

    /**
     * avoid 必须是**菜单里真实存在的商品名**。
     *
     * 模型很爱写"避免同时点多个同类汉堡"这种建议句，
     * 直接拿去选品会因为匹配不上而完全不起作用（等于没重配）。
     * 这里只保留能对上菜单的，对不上就丢掉。
     */
    const menuNames = input.menu.map((m) => m.name);
    const avoidNames = Array.isArray(result.avoid)
      ? [
          ...new Set(
            result.avoid
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim())
              // 必须能在菜单里找到同名的项，否则不是商品名而是建议句
              .filter((s) => s !== '' && menuNames.some((n) => n.includes(s) || s.includes(n))),
          ),
        ].slice(0, 3)
      : [];

    /* ---- severity 判定：模型说了算，但必须自洽 ---- */
    let severity: ReviewResult['severity'] = 'none';
    if (result.ok === false) {
      const claimed = result.severity === 'major' ? 'major' : result.severity === 'minor' ? 'minor' : null;
      // 没报 severity 但给了要删的项 → 当作 minor（保守，先做减法）
      severity = claimed ?? (issues.length > 0 ? 'minor' : 'none');
    }
    /**
     * 说 major 却给不出任何可执行手段 → 降级。
     *
     * 否则会触发一次"不知道为什么重配"的重选：白烧一次 MCP 额度，
     * 还可能配得比原来更乱。宁可只做减法。
     */
    if (severity === 'major' && avoidNames.length === 0 && issues.length === 0) {
      severity = 'none';
    }
    if (severity === 'major' && avoidNames.length === 0) {
      severity = 'minor';
    }

    const ok = severity === 'none';

    if (!ok) {
      log.info(
        `复核判 ${severity}：${verdict ?? ''} | ` +
          (issues.length > 0 ? `删 ${issues.map((i) => `#${i.index}`).join(',')}` : '无删除') +
          (avoidNames.length > 0 ? ` | 避开 ${avoidNames.join('、')}` : ''),
      );
    }

    return {
      ok,
      issues,
      checked: true,
      severity,
      ...(verdict ? { verdict } : {}),
      ...(severity === 'major' && avoidNames.length > 0 ? { avoidNames } : {}),
    };
  } catch (err) {
    log.warn(`复核失败（忽略）：${(err as Error).message}`);
    return { ok: true, issues: [], checked: false, severity: 'none' };
  }
}

/**
 * 复核结论 → 处理方式。
 *
 * 单拎出来是为了可测：真实链路上规则选品已经很克制，很难自然触发 major，
 * 但「真不合理时要改单」这条路径必须确定是通的 —— 只能靠单测锁住。
 */
export type ReviewDecision =
  | { action: 'keep' }
  | { action: 'prune'; issues: ReviewIssue[] }
  | { action: 'rebuild'; avoidNames: string[]; issues: ReviewIssue[] };

export function decideAction(review: ReviewResult): ReviewDecision {
  if (review.severity === 'none') return { action: 'keep' };

  if (review.severity === 'major' && review.avoidNames && review.avoidNames.length > 0) {
    return { action: 'rebuild', avoidNames: review.avoidNames, issues: review.issues };
  }

  // minor，或 major 但没给出可避开的商品名 → 退一步做减法
  if (review.issues.some((i) => i.fix !== 'none' && i.index !== undefined)) {
    return { action: 'prune', issues: review.issues };
  }

  // 既不能改单也不能做减法 → 不动
  return { action: 'keep' };
}

/* ------------------------------------------------------------------ */
/* 本地纠偏                                                          */
/* ------------------------------------------------------------------ */

/** 按 spec 里的 ×N 读出份数 */
function qtyOfItem(m: MenuItem): number {
  const n = parseInt((m.spec ?? '').match(/×\s*(\d+)/)?.[1] ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 把某一项的份数改写成 n（n<=0 表示整项删掉） */
function withQty(m: MenuItem, n: number): MenuItem {
  return { ...m, spec: `×${n}` };
}

/**
 * 执行复核建议。
 *
 * 只在**本地**做减法：删项 / 减份数。
 * 绝不按模型的话新增商品或改价 —— 加东西必须回到规则选品。
 *
 * 返回新的菜单 + 实际做了哪些动作（给日志和测试断言用）。
 */
export function applyReviewFixes(
  menu: MenuItem[],
  issues: ReviewIssue[],
): { menu: MenuItem[]; applied: string[] } {
  // 同一项被多条建议命中时，取删得最多的那条，避免 A 说删 1、B 说删 2 打架
  const plan = new Map<number, { removeAll: boolean; qty: number; fix: ReviewFix }>();

  for (const it of issues) {
    if (it.fix === 'none' || it.index === undefined) continue;
    if (!menu[it.index]) continue;

    const cur = plan.get(it.index);
    const removeAll = it.qty === undefined;
    if (!cur) {
      plan.set(it.index, { removeAll, qty: it.qty ?? 0, fix: it.fix });
    } else {
      cur.removeAll = cur.removeAll || removeAll;
      cur.qty = Math.max(cur.qty, it.qty ?? 0);
    }
  }

  if (plan.size === 0) return { menu, applied: [] };

  const applied: string[] = [];
  const out: MenuItem[] = [];

  menu.forEach((m, i) => {
    const p = plan.get(i);
    if (!p) {
      out.push(m);
      return;
    }

    const curQty = qtyOfItem(m);
    if (p.removeAll) {
      applied.push(`删除 #${i} ${m.name}（${p.fix}）`);
      return; // 整项丢掉
    }

    const next = curQty - p.qty;
    if (next <= 0) {
      applied.push(`删除 #${i} ${m.name}（${p.fix}）`);
      return;
    }
    applied.push(`#${i} ${m.name} ×${curQty}→×${next}（${p.fix}）`);
    out.push(withQty(m, next));
  });

  // 兜底：纠偏不能把菜单清空，否则用户拿到空结果还不如不纠
  if (out.length === 0) {
    log.warn('纠偏会把菜单清空，放弃本次纠偏');
    return { menu, applied: [] };
  }

  return { menu: out, applied };
}
