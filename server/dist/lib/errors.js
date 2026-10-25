export class AppError extends Error {
    code;
    status;
    retriable;
    constructor(code, message, status, retriable = false) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.status = status;
        this.retriable = retriable;
    }
    toBody() {
        return { error: this.code, message: this.message, retriable: this.retriable };
    }
}
export class AuthError extends AppError {
    constructor(message = '麦当劳授权已失效，请重新粘贴 Token') {
        super('TOKEN_INVALID', message, 401, false);
        this.name = 'AuthError';
    }
}
export class UnauthorizedError extends AppError {
    constructor(message = '请先登录') {
        super('UNAUTHORIZED', message, 401, false);
        this.name = 'UnauthorizedError';
    }
}
export class ForbiddenError extends AppError {
    constructor(message = '无权访问该资源') {
        super('UNAUTHORIZED', message, 403, false);
        this.name = 'ForbiddenError';
    }
}
export class RateLimitError extends AppError {
    constructor(message = '请求太频繁了，歇一下再试') {
        super('RATE_LIMITED', message, 429, true);
        this.name = 'RateLimitError';
    }
}
export class McpDownError extends AppError {
    constructor(message = '麦当劳那边暂时连不上，稍后再试') {
        super('MCP_DOWN', message, 503, true);
        this.name = 'McpDownError';
    }
}
export class LlmFailedError extends AppError {
    constructor(message = '我一时没想好怎么说，换个说法再问我一次？') {
        super('LLM_FAILED', message, 502, true);
        this.name = 'LlmFailedError';
    }
}
export class BadRequestError extends AppError {
    constructor(message = '请求参数不对') {
        super('BAD_REQUEST', message, 400, false);
        this.name = 'BadRequestError';
    }
}
export class NotFoundError extends AppError {
    constructor(message = '没找到你要的东西') {
        super('NOT_FOUND', message, 404, false);
        this.name = 'NotFoundError';
    }
}
export class OrderConflictError extends AppError {
    constructor(message = '菜单或价格刚刚变了，请重新确认') {
        super('ORDER_CONFLICT', message, 409, true);
        this.name = 'OrderConflictError';
    }
}
/**
 * 门店/账户明确拒绝了这次下单（限购、售罄、打烊等）。
 *
 * 与 OrderConflictError 的区别：
 *   · OrderConflict 是「我们这边状态对不上，刷新一下可能就好了」→ retriable
 *   · OrderRejected 是「对方明确说了不行」→ 不 retriable，重试也没用
 * message 直接透传 MCP 的原话，用户才知道到底为什么下不了单。
 */
export class OrderRejectedError extends AppError {
    constructor(message = '这次下单被门店拒绝了') {
        super('ORDER_REJECTED', message, 422, false);
        this.name = 'OrderRejectedError';
    }
}
export class GuestLimitError extends AppError {
    constructor(message = '访客只能体验一次，粘贴 Token 让我真正记住你') {
        super('GUEST_LIMIT_REACHED', message, 429, false);
        this.name = 'GuestLimitError';
    }
}
/**
 * 需要定位授权。
 *
 * 为什么单独一个错：麦当劳查门店只认「城市 + 关键词」，
 * 不知道城市就查不到任何门店。前端拿到这个码应该弹「允许定位」，
 * 用户同意后调 POST /api/location，再重试本轮对话。
 */
export class NeedLocationError extends AppError {
    constructor(message = '打开定位，我才能查到离你最近的门店') {
        super('NEED_LOCATION', message, 400, true);
        this.name = 'NeedLocationError';
    }
}
/** 任意异常 → 统一错误响应体 */
export function toApiError(err) {
    if (err instanceof AppError) {
        return { status: err.status, body: err.toBody() };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
        status: 500,
        body: { error: 'INTERNAL', message: '我这边出了点小状况，稍后再试一次', retriable: true },
    };
}
/**
 * 判断一段文本是否表示"鉴权失效"。
 *
 * 麦当劳 MCP 的鉴权错误是中文的（实测：「当前鉴权码不存在或已失效!」），
 * 早期只写了英文关键词，导致 Token 过期时被当成 INTERNAL 500 抛给用户，
 * 既不符合契约（§3 要求 401/403 → TOKEN_INVALID），也丢掉了"重新粘贴 Token"的引导。
 * 这里中英文全覆盖，宁可按鉴权处理（可自愈）也不要错报 500。
 */
export function looksLikeAuthError(text) {
    if (!text)
        return false;
    // 英文
    if (/401|403|unauthor|forbidden|token\s*(invalid|expired)|invalid\s*token/i.test(text))
        return true;
    // 中文：鉴权 / 授权 / 登录态 失效或过期
    if (/鉴权|授权码|登录态/.test(text))
        return true;
    if (/(token|令牌|凭证)\s*已?\s*(无效|失效|过期|不存在|不对|错误)/i.test(text))
        return true;
    if (/(未登录|请先登录|重新登录|登录已?失效|登录已?过期)/.test(text))
        return true;
    return false;
}
/** 从 MCP 侧错误推断业务异常（供 gateway 使用） */
export function mapMcpError(err) {
    const e = err;
    const status = e?.status ?? e?.statusCode;
    const msg = e?.message ?? String(err);
    if (status === 401 || status === 403)
        return new AuthError();
    if (status === 429)
        return new RateLimitError();
    if (status !== undefined && status >= 500)
        return new McpDownError();
    const code = String(e?.code ?? '');
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ABORT_ERR/i.test(code + ' ' + msg)) {
        return new McpDownError();
    }
    if (looksLikeAuthError(msg))
        return new AuthError();
    if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg))
        return new RateLimitError();
    if (/timeout|timed out/i.test(msg))
        return new McpDownError();
    // 其余（参数错误等）当普通错误抛出，便于暴露 bug
    return new AppError('INTERNAL', msg, 500, false);
}
//# sourceMappingURL=errors.js.map