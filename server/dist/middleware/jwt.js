import { loadConfig } from '../config.js';
import { verifyJwt } from '../services/auth.service.js';
import { UnauthorizedError } from '../lib/errors.js';
export function requireAuth(req, res, next) {
    try {
        const cfg = loadConfig();
        const raw = req.cookies?.[cfg.cookieName];
        if (!raw)
            throw new UnauthorizedError('请先登录');
        req.userId = verifyJwt(raw);
        next();
    }
    catch (err) {
        next(err);
    }
}
/** 可选登录：有则挂 userId，无则放行（访客用） */
export function optionalAuth(req, _res, next) {
    try {
        const cfg = loadConfig();
        const raw = req.cookies?.[cfg.cookieName];
        if (raw) {
            try {
                req.userId = verifyJwt(raw);
            }
            catch {
                /* 访客路径：忽略无效会话 */
            }
        }
    }
    finally {
        next();
    }
}
export function currentUserId(req) {
    if (!req.userId)
        throw new UnauthorizedError('请先登录');
    return req.userId;
}
//# sourceMappingURL=jwt.js.map