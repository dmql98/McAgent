/**
 * 购物车意图解析测试
 *
 * 核心命题：**认不出来就别乱认**。
 * 把「两个人 100 块」误判成"改购物车"，会毁掉用户正在配的一单；
 * 反之把「删掉薯条」漏判成选品，会把整份菜单换掉。
 * 两种都烦人，所以每条规则都要有正反面用例。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCartIntent,
  findItemByName,
  cnToNum,
  extractQty,
} from '../src/services/cart-intent.service.js';

describe('数字解析', () => {
  test('阿拉伯数字', () => {
    assert.equal(cnToNum('3'), 3);
    assert.equal(cnToNum('10'), 10);
  });

  test('中文数字（点餐会用到的那几个）', () => {
    assert.equal(cnToNum('一'), 1);
    assert.equal(cnToNum('两'), 2);
    assert.equal(cnToNum('三'), 3);
    assert.equal(cnToNum('十'), 10);
    assert.equal(cnToNum('十二'), 12);
    assert.equal(cnToNum('二十'), 20);
  });

  test('从句子取数量', () => {
    assert.equal(extractQty('可乐来两杯'), 2);
    assert.equal(extractQty('加3个苹果片'), 3);
    assert.equal(extractQty('再来一份薯条'), 1);
    assert.equal(extractQty('加个薯条'), 1, '没说数量默认 1');
  });
});

describe('购物车指令识别', () => {
  test('删除', () => {
    for (const [text, want] of [
      ['薯条删掉', '薯条'],
      ['把可乐去掉', '可乐'],
      ['不要薯条了', '薯条'],
      ['删掉麦乐鸡', '麦乐鸡'],
      // 「动词在句尾」的两种说法：早期会把整句当成商品名
      ['把薯条删了', '薯条'],
      ['薯条删了', '薯条'],
      ['把新地删了', '新地'],
    ] as const) {
      const a = parseCartIntent(text);
      assert.equal(a.kind, 'remove', text);
      // 严格相等：「把薯条删了」必须解析成「薯条」，不能留动词和语气词
      assert.equal(a.kind === 'remove' ? a.query : null, want, `${text} → ${JSON.stringify(a)}`);
    }
  });

  test('商品名里不会残留动词或语气词', () => {
    const dirty = ['把', '删了', '删掉', '了', '吧', '呢'];
    for (const text of ['把薯条删了', '汉堡删掉吧', '把可乐去掉了'] as const) {
      const a = parseCartIntent(text);
      assert.equal(a.kind, 'remove', text);
      if (a.kind !== 'remove') continue;
      for (const d of dirty) {
        assert.ok(!a.query.includes(d), `${text} 解析出的「${a.query}」不该包含「${d}」`);
      }
    }
  });

  test('加购 + 数量', () => {
    const a1 = parseCartIntent('加个苹果片');
    assert.equal(a1.kind, 'add');
    if (a1.kind === 'add') {
      assert.ok(a1.query.includes('苹果片'), a1.query);
      assert.equal(a1.qty, 1);
    }

    const a2 = parseCartIntent('可乐来两杯');
    assert.equal(a2.kind, 'add');
    if (a2.kind === 'add') assert.equal(a2.qty, 2);
  });

  test('改数量', () => {
    const a = parseCartIntent('薯条改成2份');
    assert.equal(a.kind, 'setQty');
    if (a.kind === 'setQty') {
      assert.equal(a.qty, 2);
      assert.ok(a.query.includes('薯条'), a.query);
    }
  });

  test('清空', () => {
    assert.equal(parseCartIntent('清空购物车').kind, 'clear');
    assert.equal(parseCartIntent('都不要了').kind, 'clear');
  });

  test('换成', () => {
    const a = parseCartIntent('把薯条换成麦辣鸡翅');
    assert.equal(a.kind, 'swap');
    if (a.kind === 'swap') {
      assert.ok(a.from.includes('薯条'), a.from);
      assert.ok(a.to.includes('鸡翅'), a.to);
    }
  });

  /**
   * 反面用例最关键：这些**绝不能**被判成改购物车。
   * 它们是正常的点餐请求，被判成改车就等于毁单。
   */
  test('正常点餐请求不误判', () => {
    const normal = [
      '两个人吃 100 块，不辣',
      '我好烦，想吃点带劲的',
      '来点甜的',
      '今天想吃汉堡',
      '一个人随便吃点',
      '有什么推荐的',
      '帮我配一单双人餐',
      '想吃清淡的，减脂期',
      '明天中午吃',
    ];
    for (const text of normal) {
      const a = parseCartIntent(text);
      assert.equal(a.kind, 'none', `「${text}」被误判成 ${JSON.stringify(a)}`);
    }
  });

  test('太长的话不当指令', () => {
    const long = '我想吃点东西但是不知道吃什么两个人一起吃预算一百块左右不要太辣也不要太甜最好有饮料';
    assert.equal(parseCartIntent(long).kind, 'none');
  });

  test('空字符串安全', () => {
    assert.equal(parseCartIntent('').kind, 'none');
    assert.equal(parseCartIntent('   ').kind, 'none');
  });
});

describe('按名字找购物车项', () => {
  const items = [
    { id: '1', name: '薯条（中）' },
    { id: '2', name: '无糖可口可乐' },
    { id: '3', name: '麦辣鸡腿汉堡' },
    { id: '4', name: '麦乐鸡5块' },
  ];

  test('用户说简称也能找到全名', () => {
    assert.equal(findItemByName(items, '薯条')?.id, '1');
    assert.equal(findItemByName(items, '可乐')?.id, '2');
  });

  test('全名精确命中', () => {
    assert.equal(findItemByName(items, '麦乐鸡5块')?.id, '4');
  });

  test('找不到返回 null（不瞎猜）', () => {
    assert.equal(findItemByName(items, '苹果派'), null);
  });

  test('多条命中取名字最短的（最通用的那款）', () => {
    const many = [
      { id: 'a', name: '大杯冰可乐' },
      { id: 'b', name: '可乐' },
      { id: 'c', name: '无糖可口可乐' },
    ];
    assert.equal(findItemByName(many, '可乐')?.id, 'b');
  });
});
