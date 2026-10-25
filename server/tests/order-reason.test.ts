/**
 * 建单失败原因解析
 *
 * 这里回归的是一个**话术 bug**，但后果不轻：
 * MCP 明明说了「今日下单数已经上限」，我们却回「建单返回看不懂，先去 App 里看看」。
 * 用户完全不知道自己是被限购了，会一直重试，而重试到明天都一样失败。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mcd-reason-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = join(tmp, 'test.db');

const { mcpFailureReason } = await import('../src/services/order.service.js');
const { getDb, closeDb } = await import('../src/db/index.js');

before(() => {
  getDb();
});

describe('mcpFailureReason', () => {
  test('真实限购响应要读得出原话', () => {
    const raw = {
      success: false,
      code: 600039,
      message: '今日下单数已经上限',
      datetime: '2026-10-25 10:53:09',
      traceId: '622d505009ed705d472fd0429d584140',
    };
    assert.equal(mcpFailureReason(raw), '今日下单数已经上限');
  });

  test('各类门店拒绝都能透传', () => {
    for (const msg of ['商品已售罄', '门店休息中，暂不接单', '余额不足，无法下单']) {
      assert.equal(mcpFailureReason({ success: false, code: 1, message: msg }), msg);
    }
  });

  test('成功响应不产生失败原因', () => {
    assert.equal(mcpFailureReason({ success: true, message: '请求成功' }), null);
  });

  test('没有 success 字段时不当失败（结构未知交给别处判断）', () => {
    assert.equal(mcpFailureReason({ orderId: 'X1', message: '随便' }), null);
  });

  test('失败但没给 message → null（这才叫真看不懂）', () => {
    assert.equal(mcpFailureReason({ success: false, code: 500 }), null);
  });

  test('message 是废话也不透传', () => {
    for (const msg of ['请求成功', '成功', 'success', 'OK']) {
      assert.equal(mcpFailureReason({ success: false, message: msg }), null, msg);
    }
  });

  test('非对象输入安全', () => {
    assert.equal(mcpFailureReason(null), null);
    assert.equal(mcpFailureReason(undefined), null);
    assert.equal(mcpFailureReason('oops'), null);
    assert.equal(mcpFailureReason(42), null);
  });
});

test.after(() => {
  closeDb();
});
