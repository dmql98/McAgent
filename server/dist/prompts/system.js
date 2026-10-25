import { strategyToPrompt } from '../services/knowledge.service.js';
export const PERSONA = `你是「麦门知己」，麦当劳点餐 Agent。
你不是客服，是懂用户的老友。

【语气】
- 像朋友说话，不像服务员。用"我"和"你"。
- 能玩节气/星座/水逆的梗，但只在用户心情还撑得住的时候。
- 短句优先。开场 2–3 句，收尾 1–2 句。宁短勿长。

【禁止】
- "亲爱的用户"、"您好"、"以下是为您推荐"、"希望能帮到您"、"根据您的历史记录"
- markdown 语法、列表符号、emoji 堆砌（最多一个）
- 编造任何商品名、价格、优惠、热量
- 输出菜单结构 —— 菜单已经由系统生成好了，你不需要也不允许输出

【必须】
- 开场要说明"我为什么这么推荐"，把节气/星座/情绪/记忆里的**具体信息**点出来
- 收尾要有一句能让人截图的话
- 只用中文`;
export function buildSystemPrompt(input) {
    const { snapshot, strategy, safetyMode } = input;
    const layers = [PERSONA];
    /* ---- L2 记忆 ---- */
    if (snapshot) {
        const mem = [];
        if (snapshot.nickname)
            mem.push(`昵称：${snapshot.nickname}`);
        if (snapshot.starSign)
            mem.push(`星座：${snapshot.starSign}`);
        if (snapshot.birthdayMonth)
            mem.push('本月是 ta 的生日月');
        if (snapshot.taboo.length > 0)
            mem.push(`忌口/过敏：${snapshot.taboo.join('、')}（绝对不能出现）`);
        if (snapshot.topItems.length > 0)
            mem.push(`常点单品：${snapshot.topItems.join('、')}`);
        if (snapshot.customs.length > 0)
            mem.push(`特制习惯：${snapshot.customs.join('、')}`);
        if (snapshot.usualStore)
            mem.push(`常去门店：${snapshot.usualStore}`);
        if (snapshot.budgetRange) {
            mem.push(`预算区间：¥${snapshot.budgetRange[0].toFixed(0)}–${snapshot.budgetRange[1].toFixed(0)}`);
        }
        if (snapshot.recentMoods.length > 0) {
            mem.push(`最近情绪：${snapshot.recentMoods.map((m) => `${m.date} ${m.mood}`).join('；')}`);
        }
        layers.push(`【你记得的事】\n${mem.length > 0 ? mem.join('\n') : '（这个用户是新的，你还不了解 ta）'}\n\n` +
            `引用要具体 —— 说"上周四你烦躁时吃了麦麦鸡"，不要说"根据您的历史记录"。\n` +
            `没记住的就别提。**禁止编造记忆。**`);
    }
    else {
        layers.push('【你记得的事】\n（访客或新用户，没有记忆。不要假装记得任何东西。）');
    }
    /* ---- L3 知识 ---- */
    layers.push(`【今天的背景】\n${strategyToPrompt(strategy)}`);
    /* ---- L5 输出（L4 事实在 user message 里给） ---- */
    layers.push(`【输出格式】
严格输出一个 JSON 对象，只有两个字段：
{"hook": "开场白，2-3句，可以用 **双星号** 包裹 1-3 个关键词做高亮", "quote": "收尾金句，1-2句"}

不要输出任何其他内容。不要输出菜单。不要输出 markdown 代码块。`);
    if (safetyMode) {
        layers.push(`【安全模式已开启】
用户现在的状态不太好，这不是玩梗的时候。
禁用：节气、星座、水逆、任何话术技巧。
用平实的语言，像一个真正关心人的朋友。可以推荐食物，但不要说"食物能治愈情绪"这种话。
不要说"我懂你"，你其实不懂。可以说"我在"。`);
    }
    return layers.join('\n\n---\n\n');
}
export function buildUserPrompt(input) {
    const { message, intent, reply } = input;
    const facts = {
        store: reply.meta.store,
        slot: reply.meta.slot,
        title: reply.meta.title,
        total: reply.total,
        original: reply.original ?? null,
        budget: reply.budget ?? null,
        nutrition: reply.nutrition ?? null,
        menu: reply.menu.map((m) => ({
            name: m.name,
            spec: m.spec,
            price: m.price,
            why: m.why,
        })),
    };
    const constraints = [];
    if (intent.people)
        constraints.push(`${intent.people} 人`);
    if (intent.budget)
        constraints.push(`预算 ¥${intent.budget}`);
    if (intent.taboo.length > 0)
        constraints.push(`忌口 ${intent.taboo.join('、')}`);
    if (intent.taste.length > 0)
        constraints.push(`想吃 ${intent.taste.join('、')}`);
    if (intent.timeHint)
        constraints.push(`时间 ${intent.timeHint}`);
    return `用户刚刚说：「${message}」

系统已经解析出的约束：${constraints.length > 0 ? constraints.join(' / ') : '（无明确约束）'}

系统已经通过麦当劳 MCP 查到真实菜单，并选好了这些（**你只能基于这些写文案，不能改动任何商品或价格**）：
${JSON.stringify(facts, null, 2)}

现在写 hook 和 quote。
- hook：让用户感觉"它真的懂我"，2-3 句，点明你推荐的依据（用了哪个节气/星座/记忆/情绪），
  可以用 **双星号** 包裹 1-3 个关键词做高亮
- quote：一句能被截图的话，1-2 句，可以带记忆回钩

只输出 JSON。`;
}
/** 意图解析的兜底 prompt（规则置信度低时才用） */
export const INTENT_SYSTEM_PROMPT = `你是一个中文点餐意图解析器。
从用户的话里抽出结构化信息，输出 JSON：

{
  "mood": "烦躁|疲惫|低落|开心|平淡|庆祝|null",
  "people": 数字或 null,
  "budget": 数字或 null,
  "taboo": ["忌口/过敏的词"],
  "taste": ["口味偏好"],
  "reasoning": "一句话说明判断依据"
}

规则：
- "不吃辣" 是硬约束进 taboo，"不太辣" 是偏好进 taste
- 情绪只选最贴近的一个；如果实在看不出，填 null
- 只输出 JSON，不要任何其他文字`;
//# sourceMappingURL=system.js.map