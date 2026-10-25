/**
 * 新架构单测：LLM 意图解析 + 旁路判断 + 约束合并
 *
 * 这条链路的核心不是"模型会怎么答"（那要花钱且不稳定），
 * 而是"模型答了之后我们怎么处理" —— 所以下面测的全是纯函数：
 *
 *   1. mergeIntent        模型结果 + 规则结果怎么合并
 *   2. applyContextToIntent 旁路结论怎么并入意图（只填空，不覆盖）
 *   3. ruleVagueToClarity 规则兜底时怎么判清晰度
 *
 * 最要紧的两条断言：
 *   · 忌口必须是**并集** —— 模型漏了规则补，漏一个就是安全问题；
 *   · clarity 必须是**模型说了算** —— 这正是修掉「帮我点个午餐被反问」的关键。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __llmIntentInternal as L } from '../src/services/llm-intent.service.js';
import { parseIntent } from '../src/services/intent.service.js';
import type { ParsedIntent } from '../src/types/contract.js';

const NOW = new Date('2026-10-25T12:00:00');
const { mergeIntent, ruleVagueToClarity, applyContextToIntent } = L;

/** 造一份规则层的解析结果 */
function rule(message: string): ParsedIntent {
  const r = parseIntent(message, NOW);
  return { ...r, clarity: ruleVagueToClarity(r), orderIntent: r.orderIntent };
}

/** 造一份模型返回 */
function llm(over: Record<string, unknown> = {}) {
  return {
    clarity: 'vague',
    orderIntent: true,
    people: null,
    budget: null,
    taboo: [],
    taste: [],
    mood: null,
    fulfillment: null,
    timeHint: null,
    safety: false,
    reasoning: '测试',
    ...over,
  };
}

/* ================================================================== */

describe('clarity：模型说了算，但对硬约束有兜底', () => {
  test('用户什么都没说，模型判 vague → vague（走旁路）', () => {
    const r = mergeIntent(rule('今天心情不错'), llm({ clarity: 'vague' }), '今天心情不错');
    assert.equal(r.clarity, 'vague');
  });

  test('「给我点个午餐」模型判 vague → vague，且不反问', () => {
    // 这正是旧架构的 bug 点：规则层因为命中 ORDER_INTENT 判成 clear，
    // 直接硬选品。新架构下模型判 vague，走旁路替他补全。
    const msg = '帮我点个午餐';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague' }), msg);
    assert.equal(r.clarity, 'vague', '应该走旁路，而不是直接选品');
    assert.equal(r.needsClarify, false, '模糊不等于要反问 —— 旁路负责补全');
  });

  test('「我要吃辣，3个人50块」模型判 clear → clear（跳过旁路）', () => {
    const msg = '我要吃辣，3个人50块';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', people: 3, budget: 50, taste: ['辣'] }), msg);
    assert.equal(r.clarity, 'clear');
    assert.equal(r.explicit.people, 3);
    assert.equal(r.explicit.budget, 50);
  });

  test('模型判 vague 但用户明说了忌口 → 强制 clear（不能白跑旁路把忌口弄丢）', () => {
    const msg = '我花生过敏，随便来点';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague', taboo: ['花生'] }), msg);
    assert.equal(r.clarity, 'clear', '有硬约束就必须直接选品');
    assert.ok(r.explicit.taboo.includes('花生'));
  });

  test('模型判 vague 但用户明说了人数 → 强制 clear', () => {
    const msg = '两个人吃';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague' }), msg);
    assert.equal(r.clarity, 'clear');
    assert.equal(r.explicit.people, 2);
  });

  test('模型判 vague 但用户明说了预算 → 强制 clear', () => {
    const msg = '50 块以内的';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague' }), msg);
    assert.equal(r.clarity, 'clear');
    assert.equal(r.explicit.budget, 50);
  });

  test('模型没给 clarity → 用规则兜底（有约束就 clear，没有就 vague）', () => {
    assert.equal(mergeIntent(rule('来点辣的'), llm({ clarity: null }), '来点辣的').clarity, 'clear');
    assert.equal(mergeIntent(rule('嗯……'), llm({ clarity: null }), '嗯……').clarity, 'vague');
  });

  test('模型给了非法 clarity 值 → 不采信，走规则兜底', () => {
    const r = mergeIntent(rule('来点辣的'), llm({ clarity: 'maybe' }), '来点辣的');
    assert.equal(r.clarity, 'clear');
  });
});

/* ================================================================== */

describe('忌口：必须是并集，且不能被模型瞎写', () => {
  test('模型漏了忌口，规则补上', () => {
    const msg = '我不吃牛肉，来点别的';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', taboo: [] }), msg);
    assert.ok(r.explicit.taboo.includes('牛肉'), '规则层必须能捞回来');
  });

  test('模型给了新忌口且原文有依据 → 采纳', () => {
    const msg = '千万别放香菜';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', taboo: ['香菜'] }), msg);
    assert.ok(r.explicit.taboo.includes('香菜'));
  });

  test('模型把口味写成忌口（原文没有否定词）→ 丢弃，否则整类菜单会被清空', () => {
    // 用户说"想吃辣"，模型却写 taboo: ["辣"]。
    // 如果采信，selector 会把所有辣的产品全过滤掉 —— 比漏判更糟。
    const msg = '想吃辣的';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', taboo: ['辣'], taste: ['辣'] }), msg);
    assert.ok(!r.explicit.taboo.includes('辣'), '不能把想吃的当忌口');
    assert.ok(r.explicit.taste.includes('辣'), '应该留在口味偏好里');
  });

  test('口味与忌口重叠时，口味让位（忌口是硬约束）', () => {
    const msg = '不吃辣';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', taboo: ['辣'], taste: ['辣'] }), msg);
    assert.ok(r.explicit.taboo.includes('辣'));
    assert.ok(!r.explicit.taste.includes('辣'), '忌口里的不该再出现在口味里');
  });
});

/* ================================================================== */

describe('人数 / 预算：模型优先，规则兜底', () => {
  test('模型给了人数就用模型的', () => {
    const r = mergeIntent(rule('来一单'), llm({ clarity: 'clear', people: 4 }), '来一单');
    assert.equal(r.explicit.people, 4);
  });

  test('模型没给，规则的中文数字转换更稳，用它', () => {
    const msg = '我们三个人';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', people: null }), msg);
    assert.equal(r.explicit.people, 3);
  });

  test('「两个汉堡」不会被模型或规则误判成 2 人', () => {
    const msg = '来两个汉堡';
    const r = mergeIntent(rule(msg), llm({ clarity: 'clear', people: null }), msg);
    assert.equal(r.explicit.people, undefined);
  });

  test('预算：模型给了浮点值 → 收敛到两位小数', () => {
    const r = mergeIntent(rule('来点吃的'), llm({ clarity: 'clear', budget: 49.999 }), '来点吃的');
    assert.equal(r.explicit.budget, 50);
  });

  test('预算超出合理范围 → 丢弃，防模型抽风', () => {
    assert.equal(mergeIntent(rule('来点吃的'), llm({ clarity: 'clear', budget: 999999 }), '来点吃的').explicit.budget, undefined);
    assert.equal(mergeIntent(rule('来点吃的'), llm({ clarity: 'clear', budget: 0 }), '来点吃的').explicit.budget, undefined);
    assert.equal(mergeIntent(rule('来点吃的'), llm({ clarity: 'clear', budget: -5 }), '来点吃的').explicit.budget, undefined);
  });

  test('人数超出合理范围 → 丢弃', () => {
    assert.equal(mergeIntent(rule('来一单'), llm({ clarity: 'clear', people: 99 }), '来一单').explicit.people, undefined);
    assert.equal(mergeIntent(rule('来一单'), llm({ clarity: 'clear', people: 0 }), '来一单').explicit.people, undefined);
  });
});

/* ================================================================== */

describe('情绪与安全', () => {
  test('模型的情绪优先于规则', () => {
    const msg = '累死了终于搞定了';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague', mood: '疲惫' }), msg);
    assert.equal(r.mood, '疲惫');
  });

  test('模型给非法情绪 → 用规则的', () => {
    const msg = '好烦啊';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague', mood: '莫名其妙' }), msg);
    assert.equal(r.mood, '烦躁');
  });

  test('任一方判 safety → 开启温和模式', () => {
    const msg = '有点撑不下去';
    const r = mergeIntent(rule(msg), llm({ clarity: 'vague', safety: false }), msg);
    assert.equal(r.safetyMode, true, '规则命中也算数');

    const msg2 = '我想消失';
    const r2 = mergeIntent(rule(msg2), llm({ clarity: 'vague', safety: true }), msg2);
    assert.equal(r2.safetyMode, true, '模型命中也算数');
  });
});

/* ================================================================== */

describe('旁路结论导入：只填空，不覆盖用户原话', () => {
  const baseIntent = mergeIntent(rule('今天很烦'), llm({ clarity: 'vague', mood: '烦躁' }), '今天很烦');

  test('旁路没跑（ran=false）→ 意图原样返回', () => {
    const out = applyContextToIntent(baseIntent, {
      ran: false, read: '', tasteHints: [], avoid: [], basis: [],
    });
    assert.deepEqual(out, baseIntent);
  });

  test('旁路的 tasteHints 先规范化再并入口味，冲突忌口的被剔除', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      explicit: { ...baseIntent.explicit, taboo: ['甜'], taste: [] },
    };
    const out = applyContextToIntent(intent, {
      ran: true, read: '心烦想吃重口', tasteHints: ['辣', '甜'], avoid: [], basis: [],
    });
    assert.ok(out.explicit.taste.includes('辣'));
    assert.ok(!out.explicit.taste.includes('甜'), '忌口里的甜不能被旁路加回来');
  });

  test('模型爱说的语义标签要翻译成引擎认得的词', () => {
    // 「解压」「省事」这种词 selector 的 matchTasteTag 不认识，
    // 直接并进去会静默失效 —— 模型说了半天，选品一个字没听进去。
    const out = applyContextToIntent(baseIntent, {
      ran: true, read: '', tasteHints: ['解压', '省事', '暖胃'], avoid: [], basis: [],
    });
    assert.ok(out.explicit.taste.includes('辣'), '解压 → 辣');
    assert.ok(out.explicit.taste.includes('大份'), '省事 → 大份（选省事的套餐）');
    assert.ok(out.explicit.taste.includes('热'), '暖胃 → 热');
    assert.ok(!out.explicit.taste.includes('解压'), '原始语义标签不该留在 taste 里');
  });

  test('认不出来的标签直接丢掉，不留在 intent 里当噪声', () => {
    const out = applyContextToIntent(baseIntent, {
      ran: true, read: '', tasteHints: ['玄学', '随缘'], avoid: [], basis: [],
    });
    assert.deepEqual(out.explicit.taste, []);
  });

  test('用户没说的才用旁路推断的人数', () => {
    const out = applyContextToIntent(baseIntent, {
      ran: true, read: '', tasteHints: [], people: 2, avoid: [], basis: [],
    });
    assert.equal(out.explicit.people, 2);
  });

  test('用户明说了人数，旁路推的不覆盖', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      explicit: { ...baseIntent.explicit, people: 5 },
    };
    const out = applyContextToIntent(intent, {
      ran: true, read: '', tasteHints: [], people: 2, avoid: [], basis: [],
    });
    assert.equal(out.explicit.people, 5, '用户说的永远优先');
  });

  test('旁路推的预算**不能**写进 explicit.budget（否则会冒出用户没说过的预算条）', () => {
    // 踩过的坑：旁路从记忆 budgetRange 上限推出 87.5，直接写进 explicit.budget，
    // 于是回复卡片上出现一条预算进度条、还触发超预算重选，用户一脸问号。
    // 而且模型每次推的数还不一样（87 / 88 / 87.5），同一句话每次菜单都不同。
    const out = applyContextToIntent(baseIntent, {
      ran: true, read: '', tasteHints: [], budget: 87.5, avoid: [], basis: [],
    });
    assert.equal(out.explicit.budget, undefined, '不能冒充用户说的预算');
    assert.equal(out.softBudget, 87.5, '只能作为软参考');
  });

  test('用户明说了预算，旁路不覆盖也不产生 softBudget', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      explicit: { ...baseIntent.explicit, budget: 30 },
    };
    const out = applyContextToIntent(intent, {
      ran: true, read: '', tasteHints: [], budget: 80, avoid: [], basis: [],
    });
    assert.equal(out.explicit.budget, 30, '用户说的预算不能被旁路盖掉');
    assert.equal(out.softBudget, undefined, '用户已明确，不需要软参考');
  });

  test('意图没有情绪时用旁路的', () => {
    const intent: ParsedIntent = { ...baseIntent, mood: null };
    const out = applyContextToIntent(intent, {
      ran: true, read: '', tasteHints: [], mood: '疲惫', avoid: [], basis: [],
    });
    assert.equal(out.mood, '疲惫');
  });

  test('意图已有情绪，旁路不覆盖', () => {
    const intent: ParsedIntent = { ...baseIntent, mood: '烦躁' };
    const out = applyContextToIntent(intent, {
      ran: true, read: '', tasteHints: [], mood: '开心', avoid: [], basis: [],
    });
    assert.equal(out.mood, '烦躁');
  });

  test('旁路的 avoid / read 会写进 intent，编排器直接取用', () => {
    const out = applyContextToIntent(baseIntent, {
      ran: true,
      read: '刚吃过麦辣鸡腿堡，今天换个口味',
      tasteHints: [],
      avoid: ['麦辣鸡腿堡'],
      basis: ['记忆里有常点记录'],
    });
    assert.deepEqual(out.contextAvoid, ['麦辣鸡腿堡']);
    assert.equal(out.contextRead, '刚吃过麦辣鸡腿堡，今天换个口味');
  });
});

/* ================================================================== */

describe('工具函数的边界', () => {
  test('asStringArray 过滤空串、超长、重复、非字符串', () => {
    const out = L.asStringArray(['辣', '辣', '', '   ', 123, null, 'a'.repeat(30), '甜']);
    assert.deepEqual(out, ['辣', '甜']);
  });

  test('asStringArray 非数组输入返回空', () => {
    assert.deepEqual(L.asStringArray(undefined), []);
    assert.deepEqual(L.asStringArray('辣'), []);
    assert.deepEqual(L.asStringArray({ a: 1 }), []);
  });

  test('asPositiveNumber 拒绝 NaN / 字符串乱写 / 超界', () => {
    assert.equal(L.asPositiveNumber('abc', 1, 10), undefined);
    assert.equal(L.asPositiveNumber(NaN, 1, 10), undefined);
    assert.equal(L.asPositiveNumber(undefined, 1, 10), undefined);
    assert.equal(L.asPositiveNumber(5, 1, 10), 5);
    assert.equal(L.asPositiveNumber('5', 1, 10), 5);
  });
});

/* ================================================================== */

describe('规则兜底时的清晰度口径', () => {
  test('没有任何约束 → vague（走旁路）', () => {
    assert.equal(ruleVagueToClarity(rule('今天好烦')), 'vague');
    assert.equal(ruleVagueToClarity(rule('给我点个午餐')), 'vague');
    assert.equal(ruleVagueToClarity(rule('随便')), 'vague');
  });

  test('有口味/人数/预算/忌口 → clear（跳过旁路）', () => {
    assert.equal(ruleVagueToClarity(rule('来点辣的')), 'clear');
    assert.equal(ruleVagueToClarity(rule('三个人')), 'clear');
    assert.equal(ruleVagueToClarity(rule('50 块以内')), 'clear');
    assert.equal(ruleVagueToClarity(rule('不吃牛肉')), 'clear');
  });

  test('只有时间词不算约束（旧口径的 bug）', () => {
    // 「今天」几乎每句话都有，但它不告诉你吃什么。
    // 旧逻辑把 timeHint 也算进 hasExplicit，导致「今天好烦」被判 clear 直接硬选品。
    assert.equal(ruleVagueToClarity(rule('今天好烦')), 'vague');
    assert.equal(ruleVagueToClarity(rule('现在想吃点什么')), 'vague');
  });
});
