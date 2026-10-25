import { OFFLINE_NOTE } from '../prompts/fallbacks.js';
export function renderReply(input) {
    const actions = [];
    const reply = {
        hook: cleanHook(input.hook),
        meta: {
            store: input.store,
            slot: input.slot,
            title: input.title,
            ...(input.fulfillment ? { fulfillment: input.fulfillment } : {}),
        },
        menu: input.menu,
        total: round2(input.total),
        quote: input.quote.trim(),
        actions,
        dataSource: input.dataSource ?? 'mcp',
    };
    if (input.original !== undefined && input.original > input.total) {
        reply.original = round2(input.original);
    }
    if (input.budget)
        reply.budget = input.budget;
    if (input.nutrition)
        reply.nutrition = input.nutrition;
    if (input.upsell)
        reply.upsell = input.upsell;
    if (input.deliveryFee)
        reply.deliveryFee = input.deliveryFee;
    if (input.address)
        reply.address = input.address;
    // 有菜单才能下单/换一换
    if (input.menu.length > 0) {
        actions.push('confirm', 'refine');
    }
    reply.actions = actions;
    // 离线兜底要显式标注（前端会加提示条）
    if (input.dataSource === 'offline') {
        reply.hook = `${OFFLINE_NOTE}\n\n${reply.hook}`;
    }
    return reply;
}
/** 反问场景：只有 hook，没有菜单 */
export function renderClarify(question, dataSource = 'mcp') {
    return {
        hook: question,
        meta: { store: '', slot: '', title: '' },
        menu: [],
        total: 0,
        quote: '你说一句，我就知道你该吃什么。',
        actions: [],
        clarifyOnly: true,
        dataSource,
    };
}
/**
 * 清洗 hook：
 * - 去掉 LLM 可能带出的 markdown 代码块
 * - 去掉列表符号
 * - 保留 **关键词** 标记（前端唯一富文本约定）
 */
export function cleanHook(raw) {
    let s = (raw ?? '').trim();
    // 剥 ```json ... ``` 或 ``` ... ```
    s = s.replace(/^```(?:json|markdown|md)?\s*/i, '').replace(/\s*```$/i, '');
    // 如果是 JSON 残留（模型输出错），尝试取 hook 字段
    if (s.startsWith('{')) {
        try {
            const obj = JSON.parse(s);
            if (typeof obj.hook === 'string')
                s = obj.hook;
        }
        catch {
            /* ignore */
        }
    }
    // 去掉行首列表符号
    s = s.replace(/^[-*•]\s+/gm, '').replace(/^\d+\.\s+/gm, '');
    // 压缩多余空行
    s = s.replace(/\n{3,}/g, '\n\n');
    // 去掉模型爱加的"以下是"开场
    s = s.replace(/^(好的|当然|没问题)[，,。!！]\s*/, '');
    return s.trim();
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/** 计算菜单总价与预算达成情况 */
export function computeTotals(menu, budgetLimit) {
    const total = round2(menu.reduce((s, m) => s + m.price, 0));
    const original = round2(menu.reduce((s, m) => s + (m.originalPrice ?? m.price), 0));
    let budget;
    if (budgetLimit !== undefined && budgetLimit > 0) {
        budget = {
            limit: budgetLimit,
            ok: total <= budgetLimit + 0.001,
            remaining: round2(Math.max(0, budgetLimit - total)),
        };
    }
    return {
        total,
        original: original > total ? original : undefined,
        budget,
    };
}
//# sourceMappingURL=reply.renderer.js.map