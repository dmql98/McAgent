/**
 * 统一错误类型
 *
 * 后端所有失败响应都是 { error, message, retriable? }。
 * 前端不靠 HTTP 状态码做分支判断 —— 业务码（TOKEN_INVALID / NEED_LOCATION /
 * GUEST_LIMIT_REACHED）才决定界面该怎么反应。
 */
import type { ErrorCode } from '../types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retriable: boolean;

  constructor(code: ErrorCode, message: string, status = 0, retriable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retriable = retriable;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 把任意异常翻译成给用户看的一句话 */
export function messageOf(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return '请求超时了';
    return e.message || '出了点问题';
  }
  return '出了点问题';
}

export function codeOf(e: unknown): ErrorCode {
  return isApiError(e) ? e.code : 'INTERNAL';
}
