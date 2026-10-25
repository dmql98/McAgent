/**
 * 购物车服务测试
 *
 * 重点不是"能加能删"，而是几个**会算错钱**的地方：
 *   1. 单价 vs 小计：MenuItem.price 是小计，CartItem.price 必须是单价
 *   2. 合计必须含外送费，否则用户看到 41 元、付款 48 元
 *   3. 同一商品同一特制要合并，不同特制要分行
 *   4. 没有 productId 的商品不能进车（下单必失败）
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  subtotalOf,
  parseQty,
  cleanSpec,
  cartToMenu,
  emptyCart,
} from '../src/services/cart.service.js';
import type { Cart, CartItem } from '../src/types/contract.js';

function item(over: Partial<CartItem> = {}): CartItem {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    productId: over.productId ?? 'P1',
    name: over.name ?? '测试商品',
    price: over.price ?? 10,
    qty: over.qty ?? 1,
    ...over,
  };
}

describe('小计计算', () => {
  test('单价 × 数量累加', () => {
    const items = [item({ price: 25.5, qty: 2 }), item({ price: 13.5, qty: 1 })];
    assert.equal(subtotalOf(items), 64.5);
  });

  test('浮点不产生 0.30000000000000004', () => {
    const items = [item({ price: 0.1, qty: 3 })];
    assert.equal(subtotalOf(items), 0.3);
  });

  test('空车是 0', () => {
    assert.equal(subtotalOf([]), 0);
  });

  test('数量必须是正整数（脏数据兜底）', () => {
    const items = [item({ price: 10, qty: 0 }), item({ price: 10, qty: 2.7 })];
    // 0 → 按 1 算（车里的行至少代表一份），2.7 → 按 2 算
    assert.equal(subtotalOf(items), 30);
  });
});

describe('spec 解析', () => {
  test('取出 ×2 的数量', () => {
    assert.equal(parseQty('×2'), 2);
    assert.equal(parseQty('×2 · 去冰'), 2);
    assert.equal(parseQty('x3'), 3);
    assert.equal(parseQty('去冰'), null);
    assert.equal(parseQty(undefined), null);
  });

  test('去掉数量只留特制', () => {
    assert.equal(cleanSpec('×2 · 去冰'), '去冰');
    assert.equal(cleanSpec('×1'), '');
    assert.equal(cleanSpec('· 少冰'), '少冰');
    assert.equal(cleanSpec(undefined), '');
  });
});

describe('购物车 → 菜单（下单用）', () => {
  /**
   * 这是最容易算错钱的一处：
   * CartItem.price 是单价，MenuItem.price 是小计。
   * 如果原样搬过去，下单金额会少一半（或者多一倍）。
   */
  test('单价要乘回数量变成小计', () => {
    const cart: Cart = {
      ...emptyCart(),
      items: [item({ name: '麦辣鸡腿汉堡', price: 25.5, qty: 2, productId: 'M1' })],
    };
    const menu = cartToMenu(cart);
    assert.equal(menu.length, 1);
    assert.equal(menu[0]!.price, 51);
    assert.ok(menu[0]!.spec.includes('×2'));
  });

  test('productId 必须保留（下单唯一凭据）', () => {
    const cart: Cart = {
      ...emptyCart(),
      items: [item({ productId: 'ABC123', name: '薯条', price: 12, qty: 1 })],
    };
    assert.equal(cartToMenu(cart)[0]!.productId, 'ABC123');
  });

  test('原价也按数量放大', () => {
    const cart: Cart = {
      ...emptyCart(),
      items: [item({ price: 30, originalPrice: 35, qty: 2 })],
    };
    assert.equal(cartToMenu(cart)[0]!.originalPrice, 70);
  });

  test('特制项带进菜单（下单要用）', () => {
    const cart: Cart = {
      ...emptyCart(),
      items: [item({ modifications: ['去冰', '少冰'], qty: 1 })],
    };
    assert.deepEqual(cartToMenu(cart)[0]!.modifications, ['去冰', '少冰']);
  });
});

describe('空车', () => {
  test('空车结构完整，前端不用判空', () => {
    const c = emptyCart('外送');
    assert.equal(c.items.length, 0);
    assert.equal(c.total, 0);
    assert.equal(c.count, 0);
    assert.equal(c.fulfillment, '外送');
  });
});
