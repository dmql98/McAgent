/**
 * 选品复核单测
 *
 * 覆盖三块：
 *   1. 人数默认 1 人 + 数量词不误判人数（intent 层）
 *   2. 复核结果的解析与 severity 判定（含"模型乱报 major 但要降级"的情况）
 *   3. 本地纠偏 applyReviewFixes —— 只做减法、不清空菜单、下标越界不误删
 *
 * 复核调用真实模型的部分不在这里测（要花钱、不稳定），
 * 这里只测"模型返回什么 → 我们怎么处理"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReviewFixes,
  decideAction,
  structuralCheck,
  type ReviewIssue,
  type ReviewResult,
} from '../src/services/menu-review.service.js';
import { parseIntent } from '../src/services/intent.service.js';
import { selectProducts, buildMenuItems } from '../src/services/selector.service.js';
import type { MenuItem, ParsedIntent } from '../src/types/contract.js';

const NOW = new Date('2026-10-25T12:00:00');

function item(name: string, qty: number, price: number): MenuItem {
  return { name, spec: `×${qty}`, why: '', price };
}

/* ------------------------------------------------------------------ */

describe('人数：没说就按一个人', () => {
  test('完全没提人不等于失败了，交给编排器兜成 1 人', () => {
    const r = parseIntent('今天有点烦，想吃点热的', NOW);
    assert.equal(r.explicit.people, undefined, '解析层不伪造人数，由编排器兜底');
  });

  test('数量词不能被当成人', () => {
    // 「两个汉堡一杯可乐」是 2 个汉堡，不是 2 个人 —— 早期会误判成 2 人
    assert.equal(parseIntent('两个汉堡一杯可乐', NOW).explicit.people, undefined);
    assert.equal(parseIntent('来两个汉堡', NOW).explicit.people, undefined);
    assert.equal(parseIntent('两份薯条', NOW).explicit.people, undefined);
    assert.equal(parseIntent('两杯可乐', NOW).explicit.people, undefined);
    assert.equal(parseIntent('我要一个套餐', NOW).explicit.people, undefined);
  });

  test('真说人数时仍然能认出来', () => {
    assert.equal(parseIntent('两个人吃', NOW).explicit.people, 2);
    assert.equal(parseIntent('4个人150', NOW).explicit.people, 4);
    assert.equal(parseIntent('就我一个', NOW).explicit.people, 1);
    assert.equal(parseIntent('我们仨', NOW).explicit.people, 3);
    // 数量词在前、人数在后，要跳过数量词找到真正的人
    assert.equal(parseIntent('两个汉堡，我们两个人吃', NOW).explicit.people, 2);
  });
});

/* ------------------------------------------------------------------ */

describe('本地纠偏：只做减法', () => {
  test('删掉重复的那杯饮料', () => {
    const menu = [
      item('麦辣鸡腿堡套餐', 1, 38.4),
      item('中可乐', 1, 11),
      item('薯条', 1, 12),
    ];
    const issues: ReviewIssue[] = [
      { kind: 'duplicate_drink', detail: '套餐自带可乐，又单点一杯', fix: 'remove_duplicate_drink', index: 1 },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu.length, 2);
    assert.ok(!r.menu.some((m) => m.name === '中可乐'));
    assert.equal(r.applied.length, 1);
  });

  test('按份数减，而不是整项删', () => {
    const menu = [item('中可乐', 2, 22), item('汉堡', 1, 25)];
    const issues: ReviewIssue[] = [
      { kind: 'duplicate_drink', detail: '多一杯', fix: 'remove_duplicate_drink', index: 0, qty: 1 },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu[0]!.spec, '×1', '份数应从 2 减到 1');
    assert.equal(r.menu.length, 2);
  });

  test('多条建议命中同一项时取删得最多的', () => {
    const menu = [item('新地', 2, 24), item('汉堡', 1, 25)];
    const issues: ReviewIssue[] = [
      { kind: 'too_many_desserts', detail: '甜品多', fix: 'remove_extra_dessert', index: 0, qty: 1 },
      { kind: 'too_much_food', detail: '整项删掉', fix: 'remove_extra_dessert', index: 0 },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu.length, 1, '整项删的优先级高于减份数');
    assert.equal(r.menu[0]!.name, '汉堡');
  });

  test('下标越界不误删', () => {
    const menu = [item('汉堡', 1, 25)];
    const issues: ReviewIssue[] = [
      { kind: 'illogical', detail: '瞎报', fix: 'remove_extra_main', index: 99 },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu.length, 1, '越界下标必须被忽略');
    assert.deepEqual(r.applied, []);
  });

  test('fix=none 的记录不动菜单', () => {
    const menu = [item('汉堡', 1, 25), item('可乐', 1, 11)];
    const issues: ReviewIssue[] = [
      { kind: 'illogical', detail: '说不上来哪不对', fix: 'none' },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu.length, 2);
    assert.deepEqual(r.applied, []);
  });

  test('纠偏会把菜单删空时，整体放弃（宁可不动）', () => {
    const menu = [item('汉堡', 1, 25)];
    const issues: ReviewIssue[] = [
      { kind: 'too_much_food', detail: '全删', fix: 'remove_extra_main', index: 0 },
    ];
    const r = applyReviewFixes(menu, issues);
    assert.equal(r.menu.length, 1, '不允许把菜单清空');
    assert.deepEqual(r.applied, []);
  });
});

/* ------------------------------------------------------------------ */

describe('复核结论 → 处理方式（非常不合理就要改单）', () => {
  const base = (over: Partial<ReviewResult>): ReviewResult => ({
    ok: true,
    issues: [],
    checked: true,
    severity: 'none',
    ...over,
  });

  test('没问题 → 不动菜单', () => {
    assert.deepEqual(decideAction(base({})), { action: 'keep' });
  });

  test('minor → 做减法，不重配', () => {
    const d = decideAction(
      base({
        ok: false,
        severity: 'minor',
        issues: [{ kind: 'duplicate_drink', detail: '多一杯可乐', fix: 'remove_extra_main', index: 1 }],
      }),
    );
    assert.equal(d.action, 'prune');
  });

  test('非常不合理（major）+ 给了要换的商品 → 必须改单重配', () => {
    const d = decideAction(
      base({
        ok: false,
        severity: 'major',
        verdict: '一个人四个主食',
        issues: [{ kind: 'too_much_food', detail: '主食过多', fix: 'remove_extra_main', index: 1 }],
        avoidNames: ['汉堡包', '鱼牛汉堡随心选单人餐'],
      }),
    );
    assert.equal(d.action, 'rebuild', 'major 必须走改单，不能只删一样了事');
    if (d.action !== 'rebuild') throw new Error('unreachable');
    assert.deepEqual(d.avoidNames, ['汉堡包', '鱼牛汉堡随心选单人餐']);
  });

  test('major 但没给出能换的商品 → 降级成做减法，不能空转', () => {
    const d = decideAction(
      base({
        ok: false,
        severity: 'major',
        issues: [{ kind: 'too_much_food', detail: '主食过多', fix: 'remove_extra_main', index: 2 }],
      }),
    );
    assert.equal(d.action, 'prune', '没有可避开的商品名时，重配只会挑回同一套，必须退成减法');
  });

  test('major 且既没商品名也没序号 → 不动，别瞎改', () => {
    const d = decideAction(base({ ok: false, severity: 'major' }));
    assert.equal(d.action, 'keep');
  });

  test('复核没跑成（checked=false）→ 一定不动', () => {
    const d = decideAction(base({ checked: false, severity: 'none' }));
    assert.equal(d.action, 'keep');
  });
});

/* ------------------------------------------------------------------ */

describe('重配：避开指定商品', () => {
  const intent: ParsedIntent = {
    explicit: { taboo: [], taste: [] },
    mood: null,
    moodConfidence: 0.5,
    needsClarify: false,
    safetyMode: false,
    source: 'rule',
    raw: '一个人吃',
    clarity: 'clear',
    orderIntent: true,
  };

  const products = [
    { productId: 'A', name: '麦辣鸡腿汉堡套餐', price: 38.4, category: '套餐' },
    { productId: 'B', name: '汉堡包', price: 15, category: '汉堡' },
    { productId: 'C', name: '薯条', price: 12, category: '小食' },
    { productId: 'D', name: '中可乐', price: 11, category: '饮料' },
  ];

  const base = {
    products,
    strategy: { name: '霜降', keywords: [], strategy: [] } as never,
    moodStrategy: null,
    snapshot: null,
    intent,
    people: 1,
  };

  test('不传 avoidNames 时正常出单', () => {
    const sel = selectProducts(base);
    assert.ok(sel.items.length > 0);
    const menu = buildMenuItems({ picked: sel.items, details: sel.details, people: 1, snapshot: null });
    assert.ok(menu.length > 0);
  });

  test('avoidNames 能把这个商品挤出去', () => {
    const first = selectProducts(base);
    const banned = first.items[0]!.name;

    const second = selectProducts({ ...base, avoidNames: [banned] });
    const names = second.items.map((p) => p.name);
    assert.ok(!names.includes(banned), `「${banned}」应该被避开，实际拿到 ${names.join('、')}`);
    assert.ok(second.items.length > 0, '避开之后仍要有东西可选');
  });

  test('避开后凑不出别的时，兜底仍能出单（不返回空菜单）', () => {
    const only = {
      ...base,
      products: [{ productId: 'A', name: '麦辣鸡腿汉堡套餐', price: 38.4, category: '套餐' }],
    };
    const sel = selectProducts({ ...only, avoidNames: ['麦辣鸡腿汉堡套餐'] });
    assert.ok(sel.items.length > 0, '全店只有这一款时也要给出东西，不能空手');
  });
});

/* ------------------------------------------------------------------ */
/* 确定性结构体检（不调模型）                                        */
/* ------------------------------------------------------------------ */

/**
 * 为什么这层必须存在：
 *   复核 prompt 写了"多人餐按名字人数计份"，但那是请求模型理解，不是保证。
 *   模型超时/乱码/判成"合理"时，复核退化成"没发现问题"，菜单原样发给用户。
 *   人数档位对不对是算术问题 —— 算术不该交给概率模型。
 */
describe('结构体检：多人餐 + 单人套餐重复', () => {
  const M = (name: string, spec: string, price: number): MenuItem => ({ name, spec, why: '', price });

  test('3 人：三人餐 + 单人套餐 ×3 → 删掉单人套餐，保留三人餐', () => {
    const menu = [
      M('畅享吃鸡三人餐', '×1', 86),
      M('吉士汉堡套餐', '×3', 96),
      M('草莓新地', '×2', 27),
    ];
    const r = structuralCheck(menu, 3);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0]!.index, 1, '要删的是单人套餐，不是三人餐');
  });

  test('3 人：只有单人套餐 ×3 → 不动（这是它能吃饱的唯一方案）', () => {
    const menu = [M('吉士汉堡套餐', '×3', 96), M('草莓新地', '×2', 27)];
    assert.equal(structuralCheck(menu, 3).issues.length, 0);
  });

  test('3 人：三人餐 + 单品汉堡 → 不动（用户可能就想加个堡换口味）', () => {
    const menu = [M('畅享吃鸡三人餐', '×1', 86), M('巨无霸', '×1', 25)];
    assert.equal(structuralCheck(menu, 3).issues.length, 0, '单品汉堡不算重复整餐');
  });

  test('5 人：三人餐 ×2 → 够 6 人，不动', () => {
    const menu = [M('畅享吃鸡三人餐', '×2', 172)];
    assert.equal(structuralCheck(menu, 5).issues.length, 0);
  });

  test('1 人：不做多人餐判断（1 人场景由其它规则管）', () => {
    const menu = [M('畅享吃鸡三人餐', '×1', 86), M('吉士汉堡套餐', '×1', 32)];
    assert.equal(structuralCheck(menu, 1).issues.length, 0);
  });

  test('删完之后必须仍够吃，否则整体放弃', () => {
    // 双人餐 ×1 只够 2 人，3 人时它在补缺口 —— 不能把单人套餐删掉
    const menu = [M('快乐吃鸡双人餐', '×1', 55.9), M('吉士汉堡套餐', '×1', 32)];
    assert.equal(structuralCheck(menu, 3).issues.length, 0);
  });

  test('应用后菜单仍非空、且价格只降不升', () => {
    const menu = [
      M('畅享吃鸡三人餐', '×1', 86),
      M('吉士汉堡套餐', '×3', 96),
      M('草莓新地', '×2', 27),
    ];
    const r = structuralCheck(menu, 3);
    const fixed = applyReviewFixes(menu, r.issues);
    assert.ok(fixed.menu.length > 0, '不能把菜单删空');
    const before = menu.reduce((s, m) => s + m.price, 0);
    const after = fixed.menu.reduce((s, m) => s + m.price, 0);
    assert.ok(after <= before, '只能减不能加');
    assert.ok(fixed.menu.some((m) => /三人餐/.test(m.name)), '三人餐必须留下');
  });
});
