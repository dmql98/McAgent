/**
 * 错误映射测试
 *
 * 背景（真实踩坑）：麦当劳 MCP 的鉴权错误文案是中文的
 * 「当前鉴权码不存在或已失效!」。早期 mapMcpError 只认英文关键词，
 * 结果 Token 过期时把 MCP 错误包成 INTERNAL 500 直接抛给用户 ——
 *   1. 违反契约 §3（401/403 必须映射为 TOKEN_INVALID）
 *   2. 用户看到一句技术报错，而不是"重新粘贴 Token"的引导
 * 这里把中英文两种鉴权文案都钉死，防止退化。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeAuthError,
  mapMcpError,
  toApiError,
  AppError,
  AuthError,
  RateLimitError,
  McpDownError,
  BadRequestError,
  NotFoundError,
  OrderConflictError,
  ForbiddenError,
  UnauthorizedError,
  GuestLimitError,
} from '../src/lib/errors.js';

describe('looksLikeAuthError — 中文鉴权文案', () => {
  const AUTH_TEXTS = [
    '当前鉴权码不存在或已失效!',
    '鉴权失败',
    '授权已过期，请重新登录',
    '登录态已失效',
    '请先登录',
    'Token 无效',
    'token expired',
    '令牌已过期',
    '凭证失效',
    'unauthorized',
    'Forbidden',
    '401 Unauthorized',
    '403 Forbidden',
    'invalid token',
  ];

  for (const t of AUTH_TEXTS) {
    test(`识别鉴权错误：${t}`, () => {
      assert.equal(looksLikeAuthError(t), true, `应判定为鉴权错误：${t}`);
    });
  }

  const NON_AUTH = [
    '商品不存在',
    '门店已打烊',
    '库存不足',
    '请求参数错误：storeId 不能为空',
    'Too many requests',
    '服务繁忙，请稍后再试',
    '',
  ];

  for (const t of NON_AUTH) {
    test(`不误判：${t || '(空字符串)'}`, () => {
      assert.equal(looksLikeAuthError(t), false, `不应判定为鉴权错误：${t}`);
    });
  }
});

describe('mapMcpError — 契约要求的语义化映射', () => {
  test('中文鉴权失效 → AuthError（TOKEN_INVALID / 401）', () => {
    const e = mapMcpError(
      new Error('Streamable HTTP error: Error POSTing to endpoint: 当前鉴权码不存在或已失效!'),
    );
    assert.ok(e instanceof AuthError);
    assert.equal(e.code, 'TOKEN_INVALID');
    assert.equal(e.status, 401);
  });

  test('HTTP 401 → AuthError', () => {
    const e = mapMcpError(Object.assign(new Error('boom'), { status: 401 }));
    assert.ok(e instanceof AuthError);
  });

  test('HTTP 403 → AuthError（契约 §3：401/403 都算 Token 失效）', () => {
    const e = mapMcpError(Object.assign(new Error('boom'), { status: 403 }));
    assert.ok(e instanceof AuthError);
  });

  test('HTTP 429 → RateLimitError，且可重试', () => {
    const e = mapMcpError(Object.assign(new Error('boom'), { status: 429 }));
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.retriable, true);
  });

  test('HTTP 5xx → McpDownError', () => {
    const e = mapMcpError(Object.assign(new Error('boom'), { status: 502 }));
    assert.ok(e instanceof McpDownError);
    assert.equal(e.status, 503);
  });

  test('连接层错误码 → McpDownError', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      const e = mapMcpError(Object.assign(new Error('x'), { code }));
      assert.ok(e instanceof McpDownError, `${code} 应映射为 McpDownError`);
    }
  });

  test('超时文案 → McpDownError', () => {
    const e = mapMcpError(new Error('request timeout after 15000ms'));
    assert.ok(e instanceof McpDownError);
  });

  test('未知错误 → INTERNAL 500（暴露 bug，不静默吞掉）', () => {
    const e = mapMcpError(new Error('商品不存在'));
    assert.equal(e.code, 'INTERNAL');
    assert.equal(e.status, 500);
  });
});

describe('toApiError — 错误体形状', () => {
  test('业务异常原样透出 code / status / retriable', () => {
    const api = toApiError(new OrderConflictError('价格变了'));
    assert.equal(api.status, 409);
    assert.deepEqual(api.body, {
      error: 'ORDER_CONFLICT',
      message: '价格变了',
      retriable: true,
    });
  });

  test('非 AppError 一律兜底为 INTERNAL，不泄露内部 message', () => {
    const api = toApiError(new Error('连接数据库失败，密码是 xxx'));
    assert.equal(api.status, 500);
    assert.equal(api.body.error, 'INTERNAL');
    assert.ok(!api.body.message.includes('密码'), '不得把内部细节透给用户');
    assert.equal(api.body.retriable, true);
  });

  test('AppError 子类契约映射表', () => {
    const table: Array<[AppError, string, number]> = [
      [new AuthError(), 'TOKEN_INVALID', 401],
      [new UnauthorizedError(), 'UNAUTHORIZED', 401],
      [new ForbiddenError(), 'UNAUTHORIZED', 403], // 契约 §1.7 明确：403 但 code 是 UNAUTHORIZED
      [new RateLimitError(), 'RATE_LIMITED', 429],
      [new McpDownError(), 'MCP_DOWN', 503],
      [new BadRequestError(), 'BAD_REQUEST', 400],
      [new NotFoundError(), 'NOT_FOUND', 404],
      [new OrderConflictError(), 'ORDER_CONFLICT', 409],
      [new GuestLimitError(), 'GUEST_LIMIT_REACHED', 429],
    ];
    for (const [err, code, status] of table) {
      const api = toApiError(err);
      assert.equal(api.body.error, code, `${err.name} 的 code`);
      assert.equal(api.status, status, `${err.name} 的 status`);
    }
  });
});
