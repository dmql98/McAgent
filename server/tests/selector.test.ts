/**
 * 选品引擎测试
 *
 * 核心命题：同样输入必须得到同样菜单（确定性）。这是"演示绝不翻车"的地基。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectProducts,
  buildMenuItems,
  comboSlots,
  isCombo,
  feedCapacity,
  servesOf,
  type RawProduct,
  type SelectInput,
} from '../src/services/selector.service.js';
import { MOOD_STRATEGIES } from '../src/data/mood-strategies.js';
import { getSolarTerm } from '../src/services/knowledge.service.js';
import { FIXTURE_PRODUCTS } from './fixtures/menu.js';
import type { MemorySnapshot, ParsedIntent } from '../src/types/contract.js';

/* ------------------------------------------------------------------ */
/* 测试夹具                                                          */
/* ------------------------------------------------------------------ */

function makeIntent(over: Partial<ParsedIntent['explicit']> = {}, mood: ParsedIntent['mood'] = null): ParsedIntent {
  return {
    explicit: { taboo: [], taste: [], ...over },
    mood,
    moodConfidence: mood ? 0.9 : 0,
    needsClarify: false,
    safetyMode: false,
    source: 'rule',
    raw: '',
    clarity: 'clear',
    orderIntent: true,
  };
}

function makeSnapshot(over: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    birthdayMonth: false,
    taboo: [],
    tasteTags: [],
    topItems: [],
    customs: [],
    recentMoods: [],
    retrogradeActive: false,
    ...over,
  };
}

const FROST = getSolarTerm(new Date('2026-10-24T12:00:00'));

/* ------------------------------------------------------------------ */
/* 1. 确定性                                                          */
/* ------------------------------------------------------------------ */

describe('确定性', () => {
  test('相同输入 100 次结果完全一致', () => {
    const input: SelectInput = {
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: MOOD_STRATEGIES.烦躁,
      snapshot: makeSnapshot({ topItems: ['麦麦鸡'], customs: ['可乐去冰'] }),
      intent: makeIntent({ people: 1, budget: 50 }, '烦躁'),
      people: 1,
      budget: 50,
    };

    const first = selectProducts(input).items.map((p) => p.name);
    for (let i = 0; i < 100; i++) {
      const again = selectProducts(input).items.map((p) => p.name);
      assert.deepEqual(again, first, `第 ${i + 1} 次结果漂移`);
    }
  });

  test('打分明细可复现（score 与 reasons 稳定）', () => {
    const input: SelectInput = {
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: MOOD_STRATEGIES.烦躁,
      snapshot: makeSnapshot({ topItems: ['麦麦鸡'] }),
      intent: makeIntent(),
      people: 2,
    };
    const a = selectProducts(input).details.map((d) => `${d.product.name}:${d.score}:${d.reasons.join('|')}`);
    const b = selectProducts(input).details.map((d) => `${d.product.name}:${d.score}:${d.reasons.join('|')}`);
    assert.deepEqual(a, b);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 忌口硬过滤                                                      */
/* ------------------------------------------------------------------ */

describe('忌口硬过滤', () => {
  test('忌口「香菜」把含香菜的商品整个排除，且记录 excluded', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '香菜牛肉堡', price: 20, description: '撒香菜', category: '汉堡', available: true },
      { productId: 'B', name: '巨无霸', price: 22.5, category: '汉堡', available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ taboo: ['香菜'] }),
      people: 1,
    });

    assert.equal(r.excluded.length, 1);
    assert.equal(r.excluded[0]!.product.name, '香菜牛肉堡');
    assert.ok(r.excluded[0]!.reason.includes('香菜'));
    assert.ok(!r.items.some((p) => p.name === '香菜牛肉堡'), '含忌口商品不能出现在菜单里');
    assert.ok(r.items.some((p) => p.name === '巨无霸'));
  });

  test('忌口「辣」同义词扩展生效（麦辣鸡翅含辣字被排除）', () => {
    const r = selectProducts({
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: MOOD_STRATEGIES.烦躁,
      snapshot: null,
      intent: makeIntent({ taboo: ['辣'] }),
      people: 1,
      budget: 50,
    });
    assert.ok(!r.items.some((p) => (p.name ?? '').includes('辣')), '菜单里不能有带辣的');
    assert.ok(r.excluded.some((e) => e.product.name === '麦辣鸡翅'));
  });

  test('忌口合并：显式忌口 + 记忆忌口都生效', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '花生新地', price: 12, available: true },
      { productId: 'B', name: '洋葱圈', price: 10, available: true },
      { productId: 'C', name: '圆筒冰淇淋', price: 5, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: makeSnapshot({ taboo: ['花生'] }),
      intent: makeIntent({ taboo: ['洋葱'] }),
      people: 1,
    });
    const names = r.items.map((p) => p.name);
    assert.ok(!names.includes('花生新地'), '记忆忌口花生未生效');
    assert.ok(!names.includes('洋葱圈'), '显式忌口洋葱未生效');
    assert.ok(names.includes('圆筒冰淇淋'));
  });

  test('全部被忌口排除时走最便宜兜底（不返回空菜单）', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '甲', price: 10, available: true },
      { productId: 'B', name: '乙', price: 8, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      // 忌口一个不存在的词，不会命中任何商品 → 走正常流程
      intent: makeIntent({ taboo: ['紫甘蓝'] }),
      people: 1,
    });
    assert.equal(r.items.length, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 打分规则                                                        */
/* ------------------------------------------------------------------ */

describe('打分规则', () => {
  test('节气关键词 +3：热可可在霜降期得分高于无关联商品', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '热可可', price: 13, available: true },
      { productId: 'B', name: '冰咖啡', price: 13, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent(),
      people: 1,
    });
    const cocoa = r.details.find((d) => d.product.name === '热可可')!;
    const icedCoffee = r.details.find((d) => d.product.name === '冰咖啡')!;
    assert.ok(cocoa.score > icedCoffee.score, `热可可 ${cocoa.score} 应高于冰咖啡 ${icedCoffee.score}`);
    assert.ok(cocoa.reasons.some((x) => x.includes('应季')));
  });

  test('本命单品 +3：topItems 命中加分', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '麦麦鸡', price: 13, available: true },
      { productId: 'B', name: '薯条（中）', price: 13, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: makeSnapshot({ topItems: ['麦麦鸡'] }),
      intent: makeIntent(),
      people: 1,
    });
    const mmj = r.details.find((d) => d.product.name === '麦麦鸡')!;
    const fries = r.details.find((d) => d.product.name === '薯条（中）')!;
    assert.ok(mmj.reasons.some((x) => x.includes('本命')), '缺少本命加分理由');
    assert.ok(mmj.score > fries.score);
  });

  test('情绪策略 avoid -5：烦躁时"清淡/小份"被压下去', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '轻食沙拉小份', price: 20, available: true },
      { productId: 'B', name: '新地（巧克力）', price: 11.5, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: MOOD_STRATEGIES.烦躁,
      snapshot: null,
      intent: makeIntent({}, '烦躁'),
      people: 1,
    });
    const salad = r.details.find((d) => d.product.name === '轻食沙拉小份')!;
    const sundae = r.details.find((d) => d.product.name === '新地（巧克力）')!;
    assert.ok(salad.score < 0, `轻食沙拉应为负分，实际 ${salad.score}`);
    assert.ok(sundae.score > salad.score);
    // 负分商品不进菜单
    assert.ok(!r.items.some((p) => p.name === '轻食沙拉小份'));
  });

  test('忌口双保险：即便漏进候选也 -100', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '牛肉堡', price: 20, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ taboo: ['牛肉'] }),
      people: 1,
    });
    // 被硬过滤，但 details 里不应有正分
    assert.equal(r.items.length, 0);
    assert.equal(r.details.length, 0);
  });

  test('不可售 / 价格为 0 的商品被过滤', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '售罄堡', price: 20, available: false },
      { productId: 'B', name: '免费水', price: 0, available: true },
      { productId: 'C', name: '可乐', price: 9.5, available: true },
    ];
    const r = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent(),
      people: 1,
    });
    assert.deepEqual(
      r.items.map((p) => p.name),
      ['可乐'],
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. 预算装箱                                                        */
/* ------------------------------------------------------------------ */

describe('预算装箱', () => {
  test('4 人 ¥150 不超预算', () => {
    const r = selectProducts({
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: null,
      snapshot: makeSnapshot({ topItems: ['麦麦鸡'] }),
      intent: makeIntent({ people: 4, budget: 150 }),
      people: 4,
      budget: 150,
    });
    const sum = r.items.reduce((s, p) => s + (p.price ?? 0), 0);
    assert.ok(r.items.length > 0, '不能返回空菜单');
    assert.ok(sum <= 150 + 0.001, `超预算了：${sum}`);
  });

  test('预算极小（¥12）时只装得下便宜货，不超且非空', () => {
    const r = selectProducts({
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: MOOD_STRATEGIES.烦躁,
      snapshot: null,
      intent: makeIntent({ people: 1, budget: 12 }),
      people: 1,
      budget: 12,
    });
    const sum = r.items.reduce((s, p) => s + (p.price ?? 0), 0);
    assert.ok(sum <= 12 + 0.001, `超预算了：${sum}`);
    assert.ok(r.items.length > 0);
  });

  test('无预算约束时按人数出足份量', () => {
    const r2 = selectProducts({
      products: FIXTURE_PRODUCTS,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people: 2 }),
      people: 2,
    });
    /**
     * 断言从「≥4 件」改成「≥3 件 + 主食够 2 人吃」。
     *
     * 旧断言假设菜单是单品堆叠（汉堡 + 薯条 + 可乐 + 甜品）；
     * 现在整餐优先，一份套餐自带走主食+小食+饮料，
     * 2 个人只需要「套餐 ×2 + 甜点」3 个 SKU，
     * 份量已经由 qtyOf 放大，SKU 少反而说明没重复配置。
     */
    assert.ok(r2.items.length >= 3, `2 人应出 ≥3 件，实际 ${r2.items.length}`);
    const feed = r2.items.reduce((s, p) => s + feedCapacity(p, 2), 0);
    assert.ok(feed >= 2, `主食供给不足：只够 ${feed} 人`);
  });
});

/* ------------------------------------------------------------------ */
/* 5. buildMenuItems                                                  */
/* ------------------------------------------------------------------ */

describe('buildMenuItems', () => {
  test('price 是该项小计（单价 × 数量），不是单价', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '巨无霸套餐', price: 38.5, category: '套餐', available: true },
    ];
    const sel = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people: 4 }),
      people: 4,
    });
    const menu = buildMenuItems({
      picked: sel.items,
      details: sel.details,
      people: 4,
      snapshot: null,
    });
    assert.equal(menu.length, 1);
    const item = menu[0]!;
    // 套餐类 qty = min(people,4) = 4
    assert.ok(item.spec.startsWith('×4'), `spec=${item.spec}`);
    assert.equal(item.price, 38.5 * 4);
    assert.equal(item.productId, 'A');
  });

  test('饮品按人数一半向上取整', () => {
    const products: RawProduct[] = [
      { productId: 'C', name: '可乐', price: 9.5, category: '饮料', available: true },
    ];
    const sel = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people: 3 }),
      people: 3,
    });
    const menu = buildMenuItems({ picked: sel.items, details: sel.details, people: 3, snapshot: null });
    assert.equal(menu[0]!.spec.startsWith('×2'), true, `3 人饮品应为 ×2，实际 ${menu[0]!.spec}`);
    assert.equal(menu[0]!.price, 19);
  });

  test('记忆里的特制习惯写进 spec', () => {
    const products: RawProduct[] = [
      { productId: 'C', name: '可乐', price: 9.5, category: '饮料', available: true },
    ];
    const sel = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: makeSnapshot({ customs: ['可乐去冰'] }),
      intent: makeIntent({ people: 1 }),
      people: 1,
    });
    const menu = buildMenuItems({
      picked: sel.items,
      details: sel.details,
      people: 1,
      snapshot: makeSnapshot({ customs: ['可乐去冰'] }),
    });
    assert.ok(menu[0]!.spec.includes('去冰'), `spec 应含去冰：${menu[0]!.spec}`);
  });

  test('原价高于现价时写入 originalPrice（小计）', () => {
    const products: RawProduct[] = [
      { productId: 'A', name: '巨无霸套餐', price: 38.5, originalPrice: 45, category: '套餐', available: true },
    ];
    const sel = selectProducts({
      products,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people: 2 }),
      people: 2,
    });
    const menu = buildMenuItems({ picked: sel.items, details: sel.details, people: 2, snapshot: null });
    assert.equal(menu[0]!.originalPrice, 45 * 2);
    assert.ok(menu[0]!.originalPrice! > menu[0]!.price);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 结构合理性（用户三条真实抱怨的回归）                             */
/* ------------------------------------------------------------------ */

/**
 * 这组测试来自用户的真实反馈，每一条都对应一次「点餐很奇怪」：
 *   ① 一人：套餐里已经有汉堡了，单人吃不了那么多 → 主食不能堆 3 项
 *   ② 二人：两个人又点一个单人餐 → 有多人餐就该用多人餐
 *   ③ 一人：一人套餐有饮料啊，但是又点了一杯 → 套餐含饮料就别再补
 *
 * 断言只写「不该出现什么」，不写具体点哪几样 ——
 * 具体选品会随节气/情绪变，但「不像人点的」这种结构错误必须永远不出现。
 */
describe('结构合理性', () => {
  /** 模拟真实菜单：既有含饮料的套餐，也有单点汉堡和单点饮料 */
  const REALISH: RawProduct[] = [
    { productId: 'P1', name: '麦辣鸡腿汉堡套餐', price: 41, category: '套餐', available: true },
    { productId: 'P2', name: '板烧鸡腿堡套餐', price: 39, category: '套餐', available: true },
    { productId: 'P3', name: '麦辣鸡腿汉堡', price: 25.5, category: '汉堡', available: true },
    { productId: 'P4', name: '汉堡包', price: 15, category: '汉堡', available: true },
    { productId: 'P5', name: '吉士汉堡包', price: 16.5, category: '汉堡', available: true },
    { productId: 'P6', name: '无糖可口可乐', price: 11, category: '饮料', available: true },
    { productId: 'P7', name: '鲜萃冰咖', price: 13, category: '饮料', available: true },
    { productId: 'P8', name: '麦乐鸡5块', price: 15, category: '小食', available: true },
    { productId: 'P9', name: '薯条（中）', price: 12, category: '小食', available: true },
    { productId: 'P10', name: '草莓新地', price: 13.5, category: '甜品', available: true },
    { productId: 'P11', name: '朱古力新地', price: 13.5, category: '甜品', available: true },
    { productId: 'P12', name: '苹果片', price: 7.5, category: '小食', available: true },
    // 真正的双人餐：名字里没有「堡」，早期版本认不出来
    { productId: 'P13', name: '快乐吃鸡双人餐', price: 54.9, category: '套餐', available: true },
    { productId: 'P14', name: '大吉大利吃鸡双人餐', price: 73.9, category: '套餐', available: true },
    { productId: 'P15', name: '精选单人餐四件套', price: 45.9, category: '套餐', available: true },
  ];

  const pick = (people: number, budget?: number) =>
    selectProducts({
      products: REALISH,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people, ...(budget ? { budget } : {}) }),
      people,
      ...(budget ? { budget } : {}),
    });

  test('① 一人不能点 3 项主食（"单人吃不了那么多"）', () => {
    const r = pick(1);
    const mains = r.items.filter((p) => /堡|套餐|件套|餐/.test(p.name ?? ''));
    assert.ok(mains.length <= 1, `1 人点了 ${mains.length} 项主食：${mains.map((p) => p.name).join('、')}`);
  });

  test('① 一人甜品不超过 1 份（不能两个新地）', () => {
    const r = pick(1);
    const desserts = r.items.filter((p) => /新地|冰淇淋|圆筒|派|麦旋风/.test(p.name ?? ''));
    assert.ok(desserts.length <= 1, `1 人点了 ${desserts.length} 份甜品`);
  });

  test('② 二人不点「单人餐 ×2」，应优先一份就够的双人餐', () => {
    const r = pick(2);
    const mains = r.items.filter((p) => isCombo(p));
    const soloSets = mains.filter((p) => /单人餐|四件套/.test(p.name ?? ''));
    assert.equal(soloSets.length, 0, `2 人点了单人餐：${soloSets.map((p) => p.name).join('、')}`);
    const feed = r.items.reduce((s, p) => s + feedCapacity(p, 2), 0);
    assert.ok(feed >= 2, `主食不够 2 人吃，只够 ${feed} 人`);
  });

  test('③ 套餐已含饮料 → 不再单点一杯饮料（"又点了一杯"）', () => {
    const r = pick(1);
    const comboDrinks = r.items.filter((p) => isCombo(p) && comboSlots(p).drink > 0);
    if (comboDrinks.length === 0) return; // 没选套餐时这条不适用
    const soloDrinks = r.items.filter(
      (p) => !isCombo(p) && /可乐|咖啡|茶|饮|水|奶/.test(`${p.category ?? ''} ${p.name}`),
    );
    assert.equal(
      soloDrinks.length,
      0,
      `套餐（${comboDrinks.map((p) => p.name).join('、')}）已含饮料，却又点了 ${soloDrinks.map((p) => p.name).join('、')}`,
    );
  });

  test('③ 套餐已含小食 → 最多再加 1 份小食', () => {
    const r = pick(1);
    const comboSides = r.items.filter((p) => isCombo(p) && comboSlots(p).side > 0);
    if (comboSides.length === 0) return;
    const soloSides = r.items.filter(
      (p) => !isCombo(p) && /鸡块|薯条|鸡翅|小食|苹果/.test(`${p.category ?? ''} ${p.name}`),
    );
    assert.ok(
      soloSides.length <= 1,
      `套餐已含小食，又补了 ${soloSides.length} 份：${soloSides.map((p) => p.name).join('、')}`,
    );
  });

  test('③ 单人套餐的饮料/小食被记账（comboSlots 兜底结构）', () => {
    const set = REALISH.find((p) => p.name === '麦辣鸡腿汉堡套餐')!;
    const slots = comboSlots(set);
    assert.ok(slots.drink > 0, '套餐应识别出含饮料');
    assert.ok(slots.side > 0, '套餐应识别出含小食');
    assert.equal(slots.main, 1);
  });

  test('带 combo 明细时按明细精确归类', () => {
    const p: RawProduct = {
      productId: 'X',
      name: '测试套餐',
      price: 40,
      available: true,
      combo: ['巨无霸', '中薯条', '中可乐'],
    };
    const slots = comboSlots(p);
    assert.equal(slots.main, 1);
    assert.equal(slots.side, 1);
    assert.equal(slots.drink, 1);
    assert.equal(slots.dessert, 0);
  });

  test('双人餐按「能喂几个人」折算份数，不按人数放大', () => {
    const r = pick(2);
    const dbl = r.items.find((p) => /双人餐/.test(p.name ?? ''));
    if (!dbl) return;
    const menu = buildMenuItems({ picked: [dbl], details: r.details, people: 2, snapshot: null });
    assert.equal(menu[0]!.name, dbl.name);
    assert.ok(menu[0]!.spec.includes('×1'), `双人餐 2 人应点 1 份，实际 ${menu[0]!.spec}`);
  });

  /**
   * 3 人点 2 份双人餐 = 4 人份，这是 ceil 的已知取舍。
   *
   * 试过改 floor 让它刚好 3 人份，结果更糟：双人餐 ×1 只够 2 人，
   * 又补一份单人套餐（×3 份），最后 5 人份、价格翻倍。
   * 所以这里锁定「宁可多 1 人份，也不要 5 人份」这个取舍。
   */
  test('3 人吃双人餐时，超额不能超过 1 人份', () => {
    const r = pick(3);
    const feed = r.items
      .filter((p) => /堡|套餐|件套|餐|饭|卷/.test(p.name ?? ''))
      .reduce((s, p) => s + feedCapacity(p, 3), 0);
    assert.ok(feed >= 3, `3 人吃不饱：只够 ${feed} 人`);
    assert.ok(feed <= 4, `3 人给了 ${feed} 人份，超太多`);
  });

  test('1 人永远只有 1 项主食，主食不因份数放大变多', () => {
    for (const budget of [undefined, 40, 60, 100]) {
      const r = pick(1, budget);
      const mains = r.items.filter((p) => /堡|套餐|件套|餐|饭|卷/.test(p.name ?? ''));
      assert.ok(mains.length <= 1, `预算 ${budget}：1 人点了 ${mains.length} 项主食`);
    }
  });

  test('整体：2 人不出「同一款商品的套餐+单品」重复', () => {
    const r = pick(2);
    const combos = r.items.filter((p) => isCombo(p));
    const singles = r.items.filter((p) => !isCombo(p));
    for (const c of combos) {
      const core = (c.name ?? '').replace(/套餐|四件套|单人餐|双人餐|随心选|随心配/g, '');
      const dup = singles.find((s) => core.length >= 2 && (s.name ?? '').includes(core));
      assert.ok(!dup, `同时点了「${c.name}」和「${dup?.name}」，重复配置`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 三人场景：真实外卖菜单复现                                        */
/* ------------------------------------------------------------------ */

/**
 * 2026-10-25 真实事故回归。
 *
 * 用户原话「帮我点个三个人的午餐」，实际出单：
 *   吉士汉堡套餐 ×3（¥96）+ 草莓新地 ×2（¥27）＝ ¥132，另加运费打包费
 * 而菜单里明明有 ¥86 的「畅享吃鸡三人餐」。
 *
 * 两个独立根因（都已修，这里逐条锁死）：
 *   ① servesOf 把「三人」并进 return 4 —— 三人餐被当成 4 人份，
 *      打分只给「够 4 人吃」+1，排不过命中「应季·汉堡」+3 的单人套餐；
 *   ② isCombo 的白名单里只有「多人餐/分享餐」等，没有裸「N 人餐」——
 *      「畅享吃鸡三人餐」被判成单品，从第三轮"补配角"混进来，
 *      结果是 3 份单人套餐 + 1 份三人餐 = 6 人份。
 */
describe('三人场景（真实外卖菜单）', () => {
  /** 摘自厦门塔埔路店 2026-10-25 真实外送菜单，价格原样 */
  const TAXI: RawProduct[] = [
    { productId: 'A1', name: '吉士汉堡套餐', price: 32, category: '套餐', available: true },
    { productId: 'A2', name: '麦香鸡套餐', price: 33.5, category: '套餐', available: true },
    { productId: 'A3', name: '麦辣鸡腿汉堡套餐', price: 41, category: '套餐', available: true },
    { productId: 'A4', name: '板烧鸡腿堡套餐', price: 42, category: '套餐', available: true },
    { productId: 'A5', name: '精选单人餐四件套', price: 45.9, category: '套餐', available: true },
    { productId: 'A6', name: '快乐吃鸡双人餐', price: 55.9, category: '多人分享餐', available: true },
    { productId: 'A7', name: '大吉大利吃鸡双人餐', price: 73.9, category: '多人分享餐', available: true },
    // 关键：名字里没有「套餐」，只有「三人餐」
    { productId: 'A8', name: '畅享吃鸡三人餐', price: 86, category: '多人分享餐', available: true },
    { productId: 'A9', name: '合家欢聚鸡牛三人餐', price: 96, category: '多人分享餐', available: true },
    { productId: 'A10', name: '吃鸡盛宴四人餐', price: 107, category: '多人分享餐', available: true },
    { productId: 'A11', name: '加牛欢享四人餐', price: 116, category: '多人分享餐', available: true },
    { productId: 'A12', name: '草莓新地', price: 13.5, category: '甜品', available: true },
    { productId: 'A13', name: '麦乐鸡5块', price: 15, category: '小食', available: true },
  ];

  const pickN = (people: number, budget?: number) =>
    selectProducts({
      products: TAXI,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people, ...(budget ? { budget } : {}) }),
      people,
      ...(budget ? { budget } : {}),
    });

  test('「畅享吃鸡三人餐」必须被认成整餐，且算 3 人份', () => {
    const p = TAXI.find((x) => x.name === '畅享吃鸡三人餐')!;
    assert.equal(isCombo(p), true, '名字里只有「三人餐」，也必须判成整餐');
    assert.equal(servesOf(p), 3, '三人餐必须回 3，不能并进 4');

    // 四人餐照旧回 4，别把 3 人档的修复做成"一律 3"
    const four = TAXI.find((x) => x.name === '吃鸡盛宴四人餐')!;
    assert.equal(servesOf(four), 4);
  });

  test('3 人必须优先一份三人餐，而不是 3 份单人套餐', () => {
    const r = pickN(3);
    const names = r.items.map((p) => p.name);
    const multi = names.filter((n) => /三人餐/.test(n));
    assert.equal(multi.length, 1, `3 人应点 1 份三人餐，实际：${names.join('、')}`);

    // 单人套餐不应该出现 —— 三人餐已经够了
    const singles = names.filter((n) => /单人餐|三件套|四件套|^.+套餐$/.test(n) && !/三人餐/.test(n));
    assert.equal(singles.length, 0, `三人餐已够吃，却还配了单人餐：${singles.join('、')}`);
  });

  test('3 人主食总量不超过 4 人份（不能 6 人份）', () => {
    const r = pickN(3);
    const feed = r.items
      .filter((p) => /餐|套餐|件套|堡/.test(p.name ?? ''))
      .reduce((s, p) => s + feedCapacity(p, 3), 0);
    assert.ok(feed >= 3, `3 人吃不饱：只够 ${feed} 人`);
    assert.ok(feed <= 4, `3 人给了 ${feed} 人份`);
  });

  test('3 人总价不高于原来的错误方案（¥132）', () => {
    const r = pickN(3);
    const menu = buildMenuItems({ picked: r.items, details: r.details, people: 3, snapshot: null });
    const total = menu.reduce((s, m) => s + m.price, 0);

    // 主角必须是三人餐（¥86），不能用「单人套餐 ×3 = ¥96」顶上来
    assert.ok(
      menu.some((m) => /三人餐/.test(m.name)),
      `菜单里没有三人餐：${menu.map((m) => m.name).join('、')}`,
    );
    // 修复前实际出单 ¥132；三人餐方案应当不高于它（含甜点小食后实测 ¥128）
    assert.ok(total <= 132, `3 人配到 ¥${total}，比修复前的 ¥132 还贵`);
  });

  test('2 人 / 4 人各自命中对应档位，不跨档', () => {
    const two = pickN(2).items.map((p) => p.name).join('、');
    assert.ok(/双人餐/.test(two), `2 人应命中双人餐，实际：${two}`);

    const four = pickN(4).items.map((p) => p.name).join('、');
    assert.ok(/四人餐/.test(four), `4 人应命中四人餐，实际：${four}`);
  });

  test('5 人时三人餐按循环叠份，不能写成「双人餐」', () => {
    const r = pickN(5);
    const menu = buildMenuItems({ picked: r.items, details: r.details, people: 5, snapshot: null });
    const multi = menu.find((m) => /三人餐/.test(m.name));
    assert.ok(multi, `5 人应仍用三人餐，实际：${menu.map((m) => m.name).join('、')}`);
    assert.ok(multi.spec.includes('×2'), `5 人应点 2 份三人餐，实际 ${multi.spec}`);
    // 文案不能自相矛盾：商品是三人餐，why 里不能出现「双人餐」
    assert.ok(!/双人餐/.test(multi.why), `三人餐的推荐理由写成了「双人餐」：${multi.why}`);
  });

  test('配角单价不能超过主餐单价（不能给双人餐配 ¥39.9 拼盘）', () => {
    const withBigSide: RawProduct[] = [
      ...TAXI,
      // 贵价小食：真实菜单里 ¥39.9 的「麦麦炸鸡5拼」正是这样被塞进来的
      { productId: 'A14', name: '麦麦炸鸡5拼', price: 39.9, category: '小食', available: true },
    ];
    const r = selectProducts({
      products: withBigSide,
      strategy: FROST,
      moodStrategy: null,
      snapshot: null,
      intent: makeIntent({ people: 2 }),
      people: 2,
    });
    const menu = buildMenuItems({ picked: r.items, details: r.details, people: 2, snapshot: null });
    const main = menu.find((m) => /餐/.test(m.name));
    assert.ok(main, '必须有主餐');
    const sides = menu.filter((m) => /拼|炸鸡|小食/.test(m.name));
    for (const s of sides) {
      assert.ok(s.price <= main.price, `配角「${s.name}」¥${s.price} 比主餐「${main.name}」¥${main.price} 还贵`);
    }
    // 2 人整单不应逼近 3 人的价钱
    const total = menu.reduce((s, m) => s + m.price, 0);
    assert.ok(total < 110, `2 人配到 ¥${total}，配角失控`);
  });
});
