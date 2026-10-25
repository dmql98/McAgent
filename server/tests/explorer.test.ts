/**
 * MCP 解析器单测
 *
 * 这些解析器直接决定「界面上能不能看见真实数据」，
 * 一旦回归，页面会静默变成空列表 —— 比报错更难发现。
 * 所以固定输入 / 固定输出地钉住它们。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseToonTable, parseMarkdownTable, looseNum } from '../src/mcp/toon-table.js';
import {
  parseMenu,
  parseMealDetail,
  parseNutrition,
  parseMyCouponsMd,
  parseAvailableCouponsMd,
  parseStoreCoupons,
  parseAccount,
  parseLottery,
  parsePrizes,
  parseMallProducts,
  parseOrder,
  parseOrderList,
  parseCampaignMd,
  parsePartyCities,
  parsePartyDates,
  parseAddresses,
  parsePrice,
  parseStoreCards,
} from '../src/services/explorer.service.js';

/* ------------------------------------------------------------------ */
/* TOON 表                                                            */
/* ------------------------------------------------------------------ */

test('TOON 表：营养表 160 行头部 + 行解析', () => {
  const text =
    '[3]{productName,energyKcl,protein,fat}\n' +
    '巨无霸,500,26,25\n' +
    '麦辣鸡翅（2块）,210,12,13\n' +
    '薯条（中）,337,4,16\n';

  const t = parseToonTable(text);
  assert.ok(t, '应解析出表');
  assert.deepEqual(t!.columns, ['productName', 'energyKcl', 'protein', 'fat']);
  assert.equal(t!.rows.length, 3);
  assert.equal(t!.rows[0]!.productName, '巨无霸');
  assert.equal(t!.rows[1]!.energyKcl, '210');
});

test('TOON 表：值里含逗号时按列数右对齐合并', () => {
  const text = '[1]{productName,energyKcal}\n巨无霸, 双层牛肉, 500\n';
  const t = parseToonTable(text);
  assert.ok(t);
  assert.equal(t!.rows[0]!.productName, '巨无霸, 双层牛肉');
  assert.equal(t!.rows[0]!.energyKcal, '500');
});

test('TOON 表：说明文字开头的文本不应误判为表', () => {
  assert.equal(parseToonTable('这是一段普通说明，没有表头。'), undefined);
});

test('Markdown 表解析', () => {
  const md = ['| 餐品 | 热量 |', '| --- | --- |', '| 巨无霸 | 500 |', '| 麦辣鸡翅 | 210 |'].join('\n');
  const rows = parseMarkdownTable(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.餐品, '巨无霸');
  assert.equal(rows[1]!.热量, '210');
});

test('looseNum：单位、千分位、空值', () => {
  assert.equal(looseNum('1,234'), 1234);
  assert.equal(looseNum('500 kcal'), 500);
  assert.equal(looseNum('26 g'), 26);
  assert.equal(looseNum('--'), undefined);
  assert.equal(looseNum(''), undefined);
  assert.equal(looseNum(undefined), undefined);
});

/* ------------------------------------------------------------------ */
/* 菜单                                                              */
/* ------------------------------------------------------------------ */

/** 真实 query-meals 形状：meals 是「以 productCode 为键的对象」 */
const MENU_SAMPLE = {
  success: true,
  code: 200,
  data: {
    categories: [
      { name: '人气热卖', meals: [{ code: '1100', tags: ['爆款'] }, { code: '1200', tags: [] }] },
      { name: '饮料', meals: [{ code: '9001', tags: ['冰'] }] },
    ],
    meals: {
      '1100': { name: '巨无霸', image: 'https://img/1.png', currentPrice: '26.5', originalPrice: '30', canWithOrder: true },
      '1200': { name: '麦辣鸡翅', image: 'https://img/2.png', currentPrice: '13', originalPrice: '13', canWithOrder: false },
      '9001': { name: '可乐', currentPrice: '9.5', originalPrice: '9.5', canWithOrder: true, discountType: '促销优惠' },
      '9999': { name: '无价商品', currentPrice: '' },
    },
    frequent: [{ code: '1100' }, { code: '9001' }],
  },
};

test('菜单：分类、标签、可售状态、常点', () => {
  const m = parseMenu(MENU_SAMPLE);

  assert.equal(m.total, 3, '无价格的商品应被丢弃');
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0]!.name, '人气热卖');
  assert.equal(m.categories[0]!.items.length, 2);

  const bigmac = m.categories[0]!.items[0]!;
  assert.equal(bigmac.code, '1100');
  assert.equal(bigmac.name, '巨无霸');
  assert.equal(bigmac.price, 26.5);
  assert.equal(bigmac.originalPrice, 30);
  assert.equal(bigmac.available, true);
  assert.deepEqual(bigmac.tags, ['爆款']);
  assert.equal(bigmac.category, '人气热卖');

  const wings = m.categories[0]!.items[1]!;
  assert.equal(wings.available, false, 'canWithOrder=false 应标记不可售');
  assert.equal(wings.originalPrice, undefined, '原价等于现价时不该有划线价');

  const coke = m.categories[1]!.items[0]!;
  assert.equal(coke.discountType, '促销优惠');

  assert.deepEqual(m.frequent.map((x) => x.name), ['巨无霸', '可乐']);
});

test('菜单：空返回不抛异常', () => {
  const m = parseMenu(null);
  assert.deepEqual(m, { categories: [], frequent: [], total: 0 });
});

/* ------------------------------------------------------------------ */
/* 餐品详情（特制项三层嵌套）                                          */
/* ------------------------------------------------------------------ */

test('餐品详情：rounds → choices → modification.items → values', () => {
  const sample = {
    data: {
      code: '1100',
      name: '巨无霸套餐',
      image: 'https://img/x.png',
      supportModify: true,
      rounds: [
        {
          name: '选择饮品',
          choices: [
            {
              code: 'c1',
              name: '可口可乐',
              isDefault: 1,
              diffPrice: '+ ¥0',
              supportModify: true,
              modification: {
                items: [
                  {
                    values: [
                      { name: '去冰', selectedKey: 'k1', unselectedKey: 'k2' },
                      { name: '少冰', selectedKey: 'k3' },
                      { name: '加冰', diffPrice: '+ ¥1' },
                    ],
                  },
                ],
              },
            },
            { code: 'c2', name: '雪碧', isDefault: 0, diffPrice: '- ¥1' },
          ],
        },
        {
          name: '选择小食',
          choices: [{ code: 'c3', name: '中薯条', isDefault: 1 }],
        },
      ],
      comboItemList: [
        { itemName: '巨无霸', itemQuantity: 1 },
        { itemName: '中薯条', itemQuantity: 2 },
      ],
    },
  };

  const d = parseMealDetail(sample);
  assert.ok(d);
  assert.equal(d!.name, '巨无霸套餐');
  assert.equal(d!.supportModify, true);
  assert.equal(d!.rounds.length, 2);

  const drink = d!.rounds[0]!;
  assert.equal(drink.name, '选择饮品');
  assert.equal(drink.choices.length, 2);
  assert.equal(drink.choices[0]!.isDefault, true, 'isDefault=1 应归一成 true');
  assert.equal(drink.choices[0]!.diffPrice, '+ ¥0');
  assert.deepEqual(drink.choices[0]!.options.map((o) => o.name), ['去冰', '少冰', '加冰']);
  assert.equal(drink.choices[0]!.options[2]!.diffPrice, '+ ¥1');
  assert.equal(drink.choices[1]!.isDefault, false);

  assert.deepEqual(d!.combo, [
    { name: '巨无霸', quantity: 1 },
    { name: '中薯条', quantity: 2 },
  ]);
});

/* ------------------------------------------------------------------ */
/* 营养                                                              */
/* ------------------------------------------------------------------ */

test('营养：TOON 原文优先，能给出热量与宏量营养素', () => {
  const raw =
    '[2]{productName,nutritionDescription,energyKcal,protein,fat,carbohydrate,sodium,calcium}\n' +
    '巨无霸,经典牛肉堡,500,26,25,42,900,120\n' +
    '麦辣鸡翅,两块装,210,12,13,9,500,30\n';
  const rows = parseNutrition(null, raw);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.productName, '巨无霸');
  assert.equal(rows[0]!.energyKcal, 500);
  assert.equal(rows[0]!.protein, 26);
  assert.equal(rows[1]!.sodium, 500);
});

test('营养：JSON 数组也吃', () => {
  const rows = parseNutrition({ data: [{ productName: '薯条', energyKcal: 337 }] }, '');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.energyKcal, 337);
});

/* ------------------------------------------------------------------ */
/* 优惠券                                                            */
/* ------------------------------------------------------------------ */

test('卡包券：markdown 券面 → 结构化', () => {
  const md = [
    '## 麦辣鸡腿堡三件套',
    '- **优惠**: ¥22.9 (用券价格)',
    '- **有效期**: 2026-10-23 00:00-2026-11-23 23:59 10:30-23:59',
    '- **领取时间**: 今日收到',
    '- **标签**: 到店专用、限时',
    '<img src="https://img/c1.png" alt="麦辣鸡腿堡三件套">',
    '',
    '## 免费脆薯饼',
    '- **优惠**: ¥0 (用券价格)',
    '- **标签**: 早餐',
  ].join('\n');

  const list = parseMyCouponsMd(md);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.title, '麦辣鸡腿堡三件套');
  assert.equal(list[0]!.price, 22.9);
  assert.equal(list[0]!.priceNote, '用券价格');
  assert.equal(list[0]!.validity, '2026-10-23 00:00-2026-11-23 23:59 10:30-23:59');
  assert.deepEqual(list[0]!.tags, ['到店专用', '限时']);
  assert.equal(list[0]!.image, 'https://img/c1.png');
  assert.equal(list[0]!.kind, 'card');
  assert.equal(list[1]!.price, 0);
});

test('可领券：标题/状态/图片', () => {
  const md = [
    '### 麦麦省优惠券列表：',
    '- 优惠券标题：免费脆薯饼 \\',
    '  状态：可领取 \\',
    '  优惠券图片：\\',
    '  <img src="https://img/a.png" alt="免费脆薯饼" width="300">',
    '- 优惠券标题：5元优惠券 \\',
    '  状态：已领取 \\',
  ].join('\n');

  const list = parseAvailableCouponsMd(md);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.title, '免费脆薯饼');
  assert.equal(list[0]!.status, '可领取');
  assert.equal(list[0]!.image, 'https://img/a.png');
  assert.equal(list[1]!.status, '已领取');
  assert.equal(list[1]!.kind, 'claimable');
});

test('门店券：结构化 JSON + 券码 + 适用商品', () => {
  const list = parseStoreCoupons({
    data: [
      {
        title: '满 40 减 8',
        couponId: 'cp1',
        couponCode: 'CODE-1',
        tradeDateTime: '2026-10-24~2026-11-24',
        products: [{ productCode: '1100', productName: '巨无霸' }, { productCode: '1200', productName: '麦辣鸡翅' }],
      },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'CODE-1');
  assert.deepEqual(list[0]!.tags, ['适用 2 款']);
  assert.equal(list[0]!.products!.length, 2);
});

/* ------------------------------------------------------------------ */
/* 积分 / 抽奖                                                        */
/* ------------------------------------------------------------------ */

test('积分：服务端拼写 Mouth 也要认', () => {
  const info = parseAccount({
    data: {
      availablePoint: '4880',
      accumulativePoint: '12000',
      currentMouthExpirePoint: '120',
      frozenPoint: '0',
      usedPoint: '7120',
    },
  });
  assert.ok(info);
  assert.equal(info!.available, 4880);
  assert.equal(info!.expiringThisMonth, 120, 'currentMouthExpirePoint 必须能读到');
  assert.equal(info!.accumulated, 12000);
  assert.equal(info!.used, 7120);
});

test('积分：不是积分响应时返回 undefined，不硬编 0', () => {
  assert.equal(parseAccount({ data: { foo: 1 } }), undefined);
});

test('抽奖：drawDecision 的本次消耗', () => {
  const info = parseLottery({
    data: {
      activityCode: 'A1',
      activityName: '秋季抽奖',
      activityStatusText: '进行中',
      drawPoint: 100,
      drawTypeText: '消耗积分抽奖',
      availableTimes: 2,
      availablePoint: 4880,
      drawDecision: {
        resourceEligible: true,
        nextConsumption: { type: 'POINTS', value: 100 },
      },
      prizes: [{ name: '免费薯条', imageUrl: 'https://img/p.png', typeText: '餐品券' }],
    },
  });
  assert.ok(info);
  assert.equal(info!.activityName, '秋季抽奖');
  assert.equal(info!.drawPoint, 100);
  assert.equal(info!.decision!.eligible, true);
  assert.match(info!.decision!.nextConsumption!, /POINTS/);
  assert.equal(info!.prizes.length, 1);
});

test('奖品：分页与 hasMore', () => {
  const r = parsePrizes({
    data: {
      prizes: [{ id: 'p1', name: '免费薯条', statusText: '可用', recordTime: '2026-10-20', timeRemindText: '3 天后过期' }],
      hasMore: true,
    },
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.remind, '3 天后过期');
  assert.equal(r.hasMore, true);
});

test('积分商城商品', () => {
  const list = parseMallProducts({
    data: [{ spuId: 101, name: '免费麦辣鸡翅券', points: 800, originalPoints: 1000, imageUrl: 'https://img/m.png', categoryName: '商品券' }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.spuId, 101);
  assert.equal(list[0]!.points, 800);
  assert.equal(list[0]!.originalPoints, 1000);
});

/* ------------------------------------------------------------------ */
/* 订单                                                              */
/* ------------------------------------------------------------------ */

test('订单：orderStatus 数字枚举映射 + 组合明细', () => {
  const o = parseOrder({
    data: {
      orderId: 'ORD1',
      orderStatus: 2,
      storeName: '留仙洞店',
      storeAddress: '深圳市南山区',
      totalAmount: '39.5',
      realTotalAmount: '35.5',
      orderProductList: [
        {
          productName: '巨无霸套餐',
          productImage: 'https://img/o.png',
          quantity: 2,
          price: '19.75',
          comboItemList: [{ itemName: '巨无霸', itemQuantity: 1 }, { itemName: '中薯条', itemQuantity: 2 }],
        },
      ],
    },
  });

  assert.ok(o);
  assert.equal(o!.status, '2');
  assert.equal(o!.statusText, '配餐中（已支付）');
  assert.equal(o!.total, 39.5);
  assert.equal(o!.realTotal, 35.5);
  assert.equal(o!.items[0]!.name, '巨无霸套餐');
  assert.equal(o!.items[0]!.quantity, 2);
  assert.deepEqual(o!.items[0]!.combo, ['巨无霸', '中薯条 ×2']);
  assert.equal(o!.extra.length, 0);
});

test('订单：未知状态不丢，原样透出', () => {
  const o = parseOrder({ orderId: 'X', status: 'weird_status' });
  assert.equal(o!.statusText, 'weird_status');
});

test('订单列表：data 数组', () => {
  const list = parseOrderList({ data: [{ orderId: 'A' }, { orderId: 'B' }, { noId: 1 }] });
  assert.deepEqual(list.map((x) => x.orderId), ['A', 'B']);
});

/* ------------------------------------------------------------------ */
/* 活动 / 派对 / 地址 / 价格                                          */
/* ------------------------------------------------------------------ */

test('活动日历：按日期分组，带今日标记', () => {
  const md = [
    '## 10月23日（往期）',
    '### 霜降品鉴会',
    '秋天的第一口热可可。',
    '<img src="https://img/e1.png">',
    '',
    '## 10月24日（今日）',
    '### 生日派对半价',
    '到店出示会员码。',
    '14:00 - 16:00',
  ].join('\n');

  const days = parseCampaignMd(md);
  assert.equal(days.length, 2);
  assert.equal(days[0]!.label, '往期');
  assert.equal(days[0]!.activities[0]!.title, '霜降品鉴会');
  assert.equal(days[0]!.activities[0]!.image, 'https://img/e1.png');
  assert.equal(days[1]!.label, '今日');
  assert.equal(days[1]!.activities[0]!.timeText, '14:00 - 16:00');
});

/**
 * 真实格式回归：2026-10 从麦当劳实际抓到的返回长这样，
 * 日期是 4 级标题、活动标题是「- **活动标题**：」而不是 ###。
 * 早期只认 #{1,2}，导致真实数据一条都解析不出来（0 天），
 * 所以这个用例必须留着守住。
 */
test('活动日历：真实返回格式（#### 日期 + - **活动标题**）', () => {
  const md = [
    '### 当前时间：2026-10-24 15:38:15',
    '',
    '### 活动列表：',
    '',
    '#### 2026年10月20日 往期回顾',
    '',
    '-   **活动标题**：麦当劳 X PEACEMINUSONE',
    '    **活动内容介绍**：GD同款联名复古棒球帽',
    '    任意餐品消费加39.9元即可得',
    '    **活动图片介绍**：',
    '    <img src="https://cms-cdn.mcd.cn/img/a.jpg" alt="" height="300">',
    '',
    '#### 2026年10月21日 往期回顾',
    '',
    '-   **活动标题**：联名徽章正式发售',
    '    **活动内容介绍**：周边第二弹',
    '    <img src="https://cms-cdn.mcd.cn/img/b.jpg" alt="">',
  ].join('\n');

  const days = parseCampaignMd(md);
  assert.equal(days.length, 2, '两个日期块都要解析出来');
  assert.equal(days[0]!.date, '2026年10月20日 往期回顾');
  assert.equal(days[0]!.label, '往期回顾');
  assert.equal(days[0]!.activities.length, 1);
  assert.equal(days[0]!.activities[0]!.title, '麦当劳 X PEACEMINUSONE');
  assert.equal(days[0]!.activities[0]!.image, 'https://cms-cdn.mcd.cn/img/a.jpg');
  // 介绍里不该残留「活动内容介绍**：」这种字段名
  assert.ok(
    !days[0]!.activities[0]!.desc!.includes('活动内容介绍'),
    `desc 残留了字段名：${days[0]!.activities[0]!.desc}`,
  );
  assert.ok(days[0]!.activities[0]!.desc!.includes('GD同款'));
  assert.equal(days[1]!.activities[0]!.title, '联名徽章正式发售');
});

/** 营养表：TOON 字符串藏在 JSON 信封的 data 字段里（实测格式） */
test('营养表：TOON 嵌在 JSON data 字符串里也能解析', () => {
  const envelope = {
    success: true,
    code: 200,
    message: '请求成功',
    data:
      '[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n' +
      '  猪柳麦满分,null,1288,308,16,16,24,781,213\n' +
      '  中薯条,null,1210,289,4,12,38,165,18',
  };
  const rows = parseNutrition(envelope, '');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.productName, '猪柳麦满分');
  assert.equal(rows[0]!.energyKcal, 308);
  assert.equal(rows[1]!.productName, '中薯条');
  assert.equal(rows[1]!.sodium, 165);
});

/** 商城订单：状态字段叫 orderStatusTitle，商品在 goods[] 里且用积分 */
test('商城订单：orderStatusTitle + goods + 积分', () => {
  const envelope = {
    success: true,
    code: 200,
    data: [
      {
        lastId: 1,
        hasNext: false,
        list: [
          {
            orderId: 'ECS1214186767710588928',
            orderStatus: 30,
            orderStatusTitle: '已完成',
            totalCount: 1,
            goods: [{ spuId: 16056, spuName: '16.9元中薯麦乐鸡组合', count: 1, points: '200' }],
          },
        ],
      },
    ],
  };
  const list = parseOrderList(envelope);
  assert.equal(list.length, 1, 'data[0].list 这层要能钻进去');
  assert.equal(list[0]!.orderId, 'ECS1214186767710588928');
  assert.equal(list[0]!.statusText, '已完成');
  assert.equal(list[0]!.totalCount, 1);
  assert.equal(list[0]!.items[0]!.name, '16.9元中薯麦乐鸡组合');
  assert.equal(list[0]!.items[0]!.points, 200);
});

test('派对城市 / 可约日期', () => {
  const cities = parsePartyCities({ data: [{ code: 'SZ', name: '深圳市', latitude: 22.5, longitude: 114.0 }] });
  assert.equal(cities[0]!.code, 'SZ');
  assert.equal(cities[0]!.latitude, 22.5);

  const dates = parsePartyDates({ data: [{ dateStr: '2026-11-01', weekday: '周日', available: true }] });
  assert.equal(dates[0]!.date, '2026-11-01');
  assert.equal(dates[0]!.available, true);
});

test('外送地址', () => {
  const list = parseAddresses({
    data: [{ addressId: 'a1', contactName: '李明', phone: '18600000000', city: '深圳市', address: '清竹园9号楼', addressDetail: '3 单元 501', isDefault: 1 }],
  });
  assert.equal(list[0]!.addressId, 'a1');
  assert.equal(list[0]!.isDefault, true);
});

test('价格试算：分 → 元，取餐方式', () => {
  const p = parsePrice({
    data: {
      productPrice: 2650,
      originalPrice: 3000,
      price: 2650,
      discount: 350,
      productList: [{ productCode: '1100', productName: '巨无霸', quantity: 1, subtotal: 2650, originalSubtotal: 3000 }],
      takeWayList: [{ code: 'take-in-store', title: '到店自取' }],
    },
  });
  assert.ok(p);
  assert.equal(p!.total, 26.5);
  assert.equal(p!.original, 30);
  assert.equal(p!.discount, 3.5);
  assert.equal(p!.items[0]!.subtotal, 26.5);
  assert.equal(p!.takeWays[0]!.code, 'take-in-store');
});

test('门店卡片：距离文案、营业状态、预约选项', () => {
  const list = parseStoreCards({
    data: [
      {
        storeCode: 'S1',
        storeName: '留仙洞店',
        address: '南山区',
        distance: 850,
        businessStatus: true,
        businessStartTime: '07:00',
        businessEndTime: '23:00',
        reservation: true,
        reservationTimeOptions: [{ time: '12:00' }],
      },
      { storeCode: 'S2', storeName: '西丽店', distance: 2300, businessStatus: false, beCode: 'BE2' },
    ],
  });

  assert.equal(list.length, 2);
  assert.equal(list[0]!.distanceText, '850 m');
  assert.equal(list[0]!.businessHours, '07:00 - 23:00');
  assert.deepEqual(list[0]!.reservationOptions, ['12:00']);
  assert.ok(list[0]!.tags.includes('营业中'));
  assert.ok(list[0]!.tags.includes('可预约'));
  assert.equal(list[1]!.distanceText, '2.30 km');
  assert.ok(list[1]!.tags.includes('休息中'));
  assert.ok(list[1]!.tags.includes('得来速'));
});
