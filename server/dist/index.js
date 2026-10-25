/**
 * 服务入口
 * 装配：中间件 → 路由 → 错误处理 → 优雅关闭
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { toApiError } from './lib/errors.js';
import { rateLimit } from './middleware/ratelimit.js';
import { authRouter, meRouter } from './routes/auth.js';
import { assetsRouter } from './routes/assets.js';
import { chatRouter } from './routes/chat.js';
import { explorerRouter } from './routes/explorer.js';
import { locationRouter } from './routes/location.js';
import { memoryRouter } from './routes/memory.js';
import { menuRouter } from './routes/menu.js';
import { ordersRouter } from './routes/orders.js';
import { cartRouter } from './routes/cart.js';
import { getDb, closeDb } from './db/index.js';
import { pingMcp, shutdownGateway } from './mcp/gateway.js';
const log = createLogger('server');
const cfg = loadConfig();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
/* ---- 基础安全头 ---- */
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
/* ---- 健康检查（不登录、不泄露版本） ---- */
app.get('/api/health', async (_req, res) => {
    const mcpReachable = await pingMcp();
    const body = { ok: true, mcp: mcpReachable ? 'reachable' : 'unreachable' };
    res.json(body);
});
/* ---- 业务路由 ---- */
app.use('/api', rateLimit({ limit: 30, scope: 'api' }));
app.use('/api/auth', authRouter);
app.use('/api', meRouter); // GET /api/me、PUT /api/profile（契约 §1.4 / §1.5 在根下）
app.use('/api/chat', chatRouter);
app.use('/api/location', locationRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/cart', cartRouter);
app.use('/api/menu', menuRouter);
app.use('/api/assets', assetsRouter);
/**
 * MCP 数据面：把 35 个工具的返回，按面板聚合成前端能直接画的结构。
 * 与上面几条的区别：上面是"产品链路"（对话/下单/记忆），
 * 这里是"数据浏览"（门店/菜单/营养/券/积分商城/订单/活动/派对/工具台），
 * 目的是让接入的每一个 MCP 能力在界面上都看得见、点得到。
 */
app.use('/api/explorer', explorerRouter);
/* ---- 静态前端（生产环境由 Nginx 托管，这里留个开发期便利） ----
 * 优先托管构建产物 web/dist（Vue + Vite 的产出）；
 * 若尚未构建，则回退到 web/ 源码目录（此时只能看到 index.html，需配合 vite dev）。
 * 之所以要优先 dist：web/index.html 是 Vite 的源码入口，引用的是 /src/main.ts，
 * 浏览器无法直接执行 TS，直接托管源码目录会白屏。
 */
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const distDir = join(webRoot, 'dist');
const staticDir = existsSync(join(distDir, 'index.html')) ? distDir : webRoot;
if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { extensions: ['html'], index: 'index.html' }));
    log.info(`静态前端：${staticDir}`);
}
/* ---- 404 ---- */
app.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.path}` });
});
/* ---- 统一错误处理 ---- */
app.use((err, _req, res, _next) => {
    const api = toApiError(err);
    if (api.body.error === 'INTERNAL') {
        log.error(`未处理异常：${err?.message ?? String(err)}`);
        if (err?.stack)
            log.debug(err.stack);
    }
    if (!res.headersSent)
        res.status(api.status).json(api.body);
});
/* ---- 启动 ---- */
const server = app.listen(cfg.port, () => {
    getDb(); // 触发建表
    log.info(`✅ 麦门知己后端已启动 http://localhost:${cfg.port}`);
    log.info(`   环境=${cfg.nodeEnv} 数据目录=${cfg.dataDir}`);
    if (!cfg.llm.apiKey)
        log.warn('   ⚠️ 未配置 LLM_API_KEY，回复将走模板兜底');
    if (cfg.mcpVerifySkip)
        log.warn('   ⚠️ MCP_VERIFY_SKIP=1，Token 校验被跳过（仅开发期）');
});
/* ---- 优雅关闭 ---- */
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在关闭…`);
    server.close(() => log.info('HTTP 服务已停止'));
    try {
        await shutdownGateway();
    }
    catch {
        /* ignore */
    }
    closeDb();
    setTimeout(() => process.exit(0), 500).unref?.();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    log.error(`未处理的 Promise 拒绝：${String(reason)}`);
});
process.on('uncaughtException', (err) => {
    log.error(`未捕获异常：${err.message}`);
});
export { app };
//# sourceMappingURL=index.js.map