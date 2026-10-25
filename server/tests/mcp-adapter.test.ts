/**
 * MCP 响应适配测试（重点：adaptOrder）
 *
 * 为什么单独盯 adaptOrder：
 * 建单是唯一一个「服务端已经产生副作用、但我们这边解析失败」也不会回滚的动作。
 * 一旦把成功响应判成失败，用户会以为没下成、再点一次 —— 结果是两份订单要付两次钱。
 * 所以这里的用例全部来自**真实响应结构**，不是编的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { adaptOrder } from '../src/services/mcp-adapter.js';

/** 真实 create-order 响应（字段已脱敏缩短，结构原样） */
const REAL_CREATE_ORDER = {
  success: true,
  code: 200,
  message: '请求成功',
  datetime: '2026-10-25 10:32:31',
  traceId: '254172281e51e9b1e143e240abe67193',
  data: {
    orderId: '1030975190000662087643260206',
    payId: '111034414147906793472',
    payH5Url: 'https://m.mcd.cn/mcp/scanToPay?orderId=1030975190000662087643260206',
    orderDetail: {
      orderId: '1030975190000662087643260206',
      orderStatus: '待支付',
      status: '10',
      storeName: '麦当劳厦门SM商业城餐厅',
    },
  },
};

describe('adaptOrder', () => {
  test('解 data 包装层（回归：曾把成功建单判成失败）', () => {
    const o = adaptOrder(REAL_CREATE_ORDER);
    assert.ok(o, '真实响应必须能解析出来');
    assert.equal(o.orderId, '1030975190000662087643260206');
  });

  test('支付链接取 payH5Url', () => {
    const o = adaptOrder(REAL_CREATE_ORDER)!;
    assert.equal(o.payUrl, 'https://m.mcd.cn/mcp/scanToPay?orderId=1030975190000662087643260206');
  });

  test('状态取可读的 orderStatus，不是数字码 "10"', () => {
    const o = adaptOrder(REAL_CREATE_ORDER)!;
    assert.equal(o.status, '待支付');
  });

  test('没有 data 包装也能解析（老格式兼容）', () => {
    const o = adaptOrder({ orderId: 'A1', payUrl: 'https://x', status: 'created' });
    assert.ok(o);
    assert.equal(o.orderId, 'A1');
    assert.equal(o.payUrl, 'https://x');
    assert.equal(o.status, 'created');
  });

  test('顶层没 orderId、只有 orderDetail.orderId 也能解析', () => {
    const o = adaptOrder({ data: { orderDetail: { orderId: 'B2', orderStatus: '待支付' } } });
    assert.ok(o, 'orderDetail 里有订单号就该认');
    assert.equal(o.orderId, 'B2');
    assert.equal(o.status, '待支付');
  });

  test('订单号缺失 → null（绝不编一个假的往下走）', () => {
    assert.equal(adaptOrder({ data: { payH5Url: 'https://x' } }), null);
    assert.equal(adaptOrder({ data: {} }), null);
    assert.equal(adaptOrder({}), null);
    assert.equal(adaptOrder(null), null);
    assert.equal(adaptOrder(undefined), null);
    assert.equal(adaptOrder('not-an-object'), null);
  });

  test('总额能取到就带上', () => {
    const o = adaptOrder({ data: { orderId: 'C3', total: 87.5 } })!;
    assert.equal(o.total, 87.5);
  });

  /**
   * 门店名。
   *
   * 这是订单上「门店」字段最权威的来源 —— 我们手里只有 storeCode，
   * 名字要么靠 city+keyword 重搜（可能搜到同城另一家），
   * 要么就得问 MCP，而 MCP 在建单响应里已经把它给我们了。
   */
  test('取 orderDetail.storeName', () => {
    const o = adaptOrder(REAL_CREATE_ORDER)!;
    assert.equal(o.storeName, '麦当劳厦门SM商业城餐厅');
  });

  test('顶层 storeName 也认', () => {
    const o = adaptOrder({ data: { orderId: 'D4', storeName: '麦当劳某店' } })!;
    assert.equal(o.storeName, '麦当劳某店');
  });

  test('没有门店名就不带这个字段（不编空串）', () => {
    const o = adaptOrder({ data: { orderId: 'D5' } })!;
    assert.equal(o.storeName, undefined);
  });

  /**
   * 显式失败响应必须判负，哪怕里面带着 id。
   *
   * 真实失败响应：{"success":false,"code":600039,"message":"今日下单数已经上限"}
   * 若让它漏过去，用户会拿到一个无效 orderId 去付款。
   */
  test('success:false 一律返回 null', () => {
    const fail = { success: false, code: 600039, message: '今日下单数已经上限' };
    assert.equal(adaptOrder(fail), null);
    // 失败响应里带 id 也不能被当成订单号
    assert.equal(adaptOrder({ success: false, code: 1, message: 'x', id: 'fake-id' }), null);
    assert.equal(adaptOrder({ success: false, data: { orderId: 'should-not-pass' } }), null);
  });

  test('success:true + 正常订单号仍然通过', () => {
    const o = adaptOrder(REAL_CREATE_ORDER);
    assert.ok(o);
  });
});
