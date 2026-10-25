# M3 · MCP 网关（连接池 + 缓存 + 限流 + 错误映射）

> 依赖：M1（需 `lib/crypto.ts` 解出 token、`db` 拿到 `token_enc`、config）。
> 只碰 `server/src/mcp/*`，不改其他目录。

---

## 复制以下全部内容到新会话

```
# 任务：实现「麦门知己」的麦当劳 MCP 网关

## 一、项目背景

「麦门知己」是麦当劳点餐 Agent，全部商品、价格、优惠券、下单都必须走麦当劳官方 MCP
（`https://mcp.mcd.cn`，Streamable HTTP，30+ 工具，平台限流 600 次/分钟）。

网关是整条链路最危险的一环，要解决四件事：
1. **每用户各自的 token** —— token 存在 SQLite 里加密（AES-256-GCM），调用时解密注入，
   明文只在内存存在，绝不落日志
2. **连接复用** —— 不能每次工具调用都重新握手，要按 user_id 维护连接池
3. **限流保护** —— 平台 600/min，但一个用户疯狂点会把额度烧完。
   只读类调用必须走 TTL 缓存，再加每用户令牌桶挡在 429 之前
4. **错误语义化** —— 401 / 429 / 超时 / 5xx 要映射成三种业务异常，让上层能做不同降级

## 二、当前状态（先读这些）

- 项目根目录：`C:\Users\dmql\Desktop\1024\mc`
- **必读**：
  - `麦门知己-架构设计.html` §8 MCP 网关设计（**这是本任务的核心依据，逐条实现**）
  - `麦门知己-PRD.html` §6 FR-5（MCP 现实校准）、§10 非功能需求（限流、降级）
  - `docs/contract.md`、`docs/mcp-tools.md`（T0 产出的工具速查表）
  - `server/src/types/contract.ts`
- 已有代码（M1 会话产出，**先读再动手**）：
  - `server/src/lib/crypto.ts` —— `decrypt(enc)` / `encrypt(raw)`
  - `server/src/services/mcp-verify.ts` —— M1 写的一次性验证连接，可作为连接工厂的起点
  - `server/src/db/index.ts` —— 查 `users.token_enc`
  - `server/src/config.ts` —— `MCP_ENDPOINT`、`DEBUG_MCP`
  - `server/src/lib/logger.ts` —— 带脱敏的 logger，**日志必须走它**
- 如果上述文件因 M1 尚未完成而不存在，先读 `麦门知己-架构设计.html` §3/§4 推断接口，
  按合理签名实现，并在回报里注明你假设了哪些签名。

## 三、本任务范围（只做 `server/src/mcp/` 下三个文件）

### 3.1 `mcp/gateway.ts` —— 核心

导出统一入口（签名与架构文档一致，可微调但要在回报里说明）：

```ts
export async function callTool<T = unknown>(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts?: { cacheTtl?: number | null; timeoutMs?: number }
): Promise<T>
```

实现要求：

**(a) 连接池**
- `Map<string, PooledClient>`，key = `userId`
- `PooledClient = { client, transport, lastUsed: number, tokenFingerprint: string }`
- `tokenFingerprint` = token 的 sha256 前 8 位。**若用户重新登录换了 token，同一 userId 但
  fingerprint 变了 → 销毁旧连接重建**（这是易漏点，必须处理）
- 空闲超时 10 分钟自动断开（定时器扫描，或 get 时惰性判断）
- 上限 50 连接，超出按 `lastUsed` LRU 淘汰
- 进程退出时（`SIGTERM`/`SIGINT`）优雅关闭全部连接
- 用 `@modelcontextprotocol/sdk` 的 `Client` + `StreamableHTTPClientTransport`，
  `requestInit.headers` 注入 `Authorization: Bearer <解密后的token>`

**(b) token 获取**
- 从 DB 读 `users.token_enc`（用 M1 的 db 单例，参数化查询）
- `decrypt()` 解密；解不出/用户不存在 → 抛 `AuthError`
- **明文 token 只作为局部变量传递，不放进任何返回对象、不放进日志、不放进错误 message**
- 可以在内存里缓存解密结果（`Map<userId, {token, expiresAt}>`，TTL 5 分钟）减少解密开销，
  但明文绝不写盘

**(c) TTL 缓存**
- 只读工具统一走缓存，key = `toolName + JSON.stringify(args) + (storeId ?? '')`
- 默认 TTL：菜单类（`query-meals`/`query-meal-detail`）10 分钟；
  门店类（`query-nearby-stores`/`delivery-query-stores`）5 分钟；
  营养类（`list-nutrition-foods`）24 小时；`now-time-info` 不缓存
- **写操作永不走缓存**：`create-order`、`cancel-order`、`auto-bind-coupons` 一律跳过缓存
  （白名单机制，默认不缓存，只有明确在只读白名单里的才缓存——这样更安全）
- 缓存实现：`Map` + 惰性过期清理 + 定时清理（每 5 分钟），不用第三方库
- 缓存命中/未命中要打 debug 日志（带工具名和耗时），方便验收"重复调用命中缓存"
- 缓存容量上限 500 条，超了删最旧

**(d) 令牌桶限流**
- 每用户 20 req/min（架构文档定的），Map 实现，滑动窗口或令牌桶都行
- **超限时不要直接抛错**：若该调用是可缓存的且有缓存值，返回缓存；
  否则抛 `RateLimitError`
- 全局限流：所有用户合计不超过 550 req/min（留 50 给安全边际），超了排队或抛
  `RateLimitError`（简单做法：抛，让上层降级）

**(e) TOON 解码**
MCP 返回的是 TOON 紧凑格式（架构文档 §8 提到）。实现 `decodeToon(raw: string): unknown`：
- 先尝试 `JSON.parse`，成功就用
- 失败则按 TOON 解析（如果 SDK 已内置解码就直接用 SDK 的；**不要自己瞎猜格式**——
  若不确定，先写一个 `TODO: 联调时确认 TOON 格式`，并把原始响应原样返回，同时打 debug 日志，
  让 M4 联调时能拿到真实数据）
- 在回报里明确说明你对 TOON 的处理方式

**(f) 错误映射**
在 `mcp/errors.ts` 定义：
```ts
export class AuthError extends Error { code = 'TOKEN_INVALID' }      // 401/403
export class RateLimitError extends Error { code = 'RATE_LIMITED' }  // 429
export class McpDownError extends Error { code = 'MCP_DOWN' }        // 超时/5xx/网络
```
映射规则：
- MCP 返回 401/403 → `AuthError`，**同时销毁该用户的连接池条目**
- MCP 返回 429 → `RateLimitError`
- 超时（默认 15s，写操作 30s）→ `McpDownError`，`retriable = true`
- 5xx → `McpDownError`
- 4xx（非 401/403/429）→ 原样包装成普通 Error 带 MCP 的 message（这类是参数错误，属 bug，要能看见）
- 连接层错误（ECONNRESET 等）→ `McpDownError`

**(g) 调试模式**
`DEBUG_MCP=1` 时，每次调用打一行：
`[mcp] user=abc1… tool=query-meals args={...} cached=false cost=320ms status=ok`
token 一律脱敏。生产环境零噪音。

### 3.2 `mcp/cache.ts` —— TTL 缓存实现（独立文件，可单测）
```ts
export class TtlCache<V> {
  constructor(opts: { maxSize: number; defaultTtlMs: number });
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
  stats(): { size: number; hits: number; misses: number };
}
```
纯逻辑、零依赖、可单测。

### 3.3 `mcp/errors.ts` —— 三个异常类 + 映射函数
外加 `toApiError(err): { status, body }`，直接对接 Hono/Express 的错误响应格式
（按 `docs/contract.md` 的统一错误体）。

### 3.4 一个手写 CLI 冒烟脚本（重要）
`server/scripts/mcp-smoke.ts`，用法：
```bash
npx tsx scripts/mcp-smoke.ts <userId>
```
依次调：`now-time-info` → `query-nearby-stores` → `query-meals`（取第一家店的菜单）→
再调一次 `query-meals`（验证缓存命中）
输出：每个工具的状态、耗时、是否命中缓存、返回数据的**结构摘要**（字段名 + 数组长度，不打印全量）。
这是联调时唯一能快速判断"MCP 到底通不通"的工具，**必须做**。

## 四、硬性约束

1. **只改 `server/src/mcp/` 下的文件**，外加 `server/scripts/mcp-smoke.ts`。
   不改 `routes/`、`services/`、`db/`、`index.ts`。（M4 会来接你的网关，不要替它写编排）
2. **明文 token 的三条红线**：不进日志、不进错误 message、不进返回值。
   `logger` 的脱敏是最后一道防线，但你自己也不能主动传出去。
3. **不确定的 MCP 工具参数不要编**。先在 smoke 脚本里实测，把真实入参写回
   `docs/mcp-tools.md`（可追加一节"实测确认"，但不要改原表）。
4. **不要为了"跑通"而伪造返回数据**。如果 MCP 连不上，让 smoke 脚本如实报错。
   如果确实需要开发期假数据，只能在 `mcp/fixtures/` 下放、且文件名带 `.fixture.json`，
   由 `MCP_FIXTURE=1` 环境变量显式开启。
5. 单进程内所有状态（池、缓存、桶）都是模块级单例，**不要每次调用 new**。
6. 优雅关闭：`process.on('SIGTERM')` 里 close 所有 transport，别让 pm2 restart 卡住。

## 五、验收标准

- [ ] `npm run build` 零错误
- [ ] `npx tsx scripts/mcp-smoke.ts <真实userId>` 能拉到真实菜单（若用户提供了 token）
- [ ] 连续调两次 `query-meals` → 第二次日志显示 `cached=true`，且耗时 < 5ms
- [ ] 把某个 token 改成假值 → 抛 `AuthError`，且该用户连接池条目被销毁（池 size -1）
- [ ] 循环调 25 次任一工具 → 第 21 次起抛 `RateLimitError`（或用缓存顶上，日志可见）
- [ ] 每次调用后 `grep` 日志，搜不到完整 token
- [ ] `TtlCache` 有单测：过期、容量淘汰、命中率统计
- [ ] 空闲 11 分钟后池里连接被清理（可把超时改成 10 秒在测试里验证，然后改回）

## 六、完成后请回报

1. 交付文件清单
2. `callTool` 的最终签名（M4 要照这个调）
3. MCP 联调实测结果：哪些工具通了、哪些参数不确定、TOON 格式到底长什么样
   （截一段真实响应的前 200 字符，**脱敏后**）
4. 缓存命中率、限流规则的实际配置值
5. 给 M4 会话的交接：调用示例 + 三个异常类的处理建议（哪些该降级、哪些该让用户重新登录）
```

---

## 执行说明

- 这个任务**必须拿到真 token 才能验透**。如果暂时没有，让会话按契约实现 + 单测覆盖缓存/限流/错误映射，
  MCP 真实调用留到有 token 时再补
- `mcp-smoke.ts` 是这个会话最有价值的产物——后面所有联调都靠它
- TOON 格式是最大的不确定点，**别让它瞎编解析器**，宁可先透传原始响应
