# 安全脱敏审计记录

> 执行时间：2026-10-24
> 执行人：开发会话（自动化）
> 触发原因：项目将以开源仓库 + 公开参赛形式提交，任何真实凭证泄露即为事故。

## 结论（先看这里）

**未发现任何泄露。** 8 项扫描全部为空，仓库可以直接公开。

| 检查项 | 结果 |
|---|---|
| Bearer Token 全文扫描 | ✅ 0 命中 |
| 常见密钥前缀（sk- / AKIA / ghp_） | ✅ 0 命中 |
| `.env` 文件（磁盘 / git 索引） | ✅ 仅 `.env.example` |
| 数据库文件（`*.db` / `*.sqlite`） | ✅ 0 命中 |
| `data/` 用户数据目录 / 备份 | ✅ 0 命中（仅 `server/src/data` 静态知识数据，非用户数据） |
| 日志文件 | ✅ 0 命中 |
| 长 hex 疑似密钥（32+ 位连续 hex） | ✅ 0 命中 |
| 硬编码公网 IP / 真实域名 | ✅ 0 命中 |

**处置动作：无。** 没有需要清理的历史提交，没有需要轮换的密钥。

---

## 逐项执行记录

### 0. 仓库状态

```
$ git rev-parse --is-inside-work-tree
NOT_A_GIT_REPO
```

当前工作区尚未初始化 git（`git init` 由提交者本人执行）。
因此 `git ls-files` 系列检查改为**磁盘实际文件扫描**（`find`），
等价的更严格检查 —— 因为还没提交过，所以"索引里干净"自然成立。

> 提交前请务必确认：`git init && git add -A && git status` 里没有 `.env`、`*.db`、`data/`、`*.log`。

### 1. 真实 Token 特征

```bash
$ grep -rn --exclude-dir={node_modules,node_modules.old,dist,.git} \
    -E "Bearer [A-Za-z0-9_.-]{20,}" .
[exit=1]        # 无匹配
```

**结果：0 命中。**

代码里所有 `Bearer` 出现位置都是**运行时拼接**，不含字面量：

- `server/src/services/mcp-verify.ts` — `` `Bearer ${token}` ``（变量）
- `server/src/mcp/gateway.ts` — `` `Bearer ${token}` ``（解密后运行时值）
- `server/scripts/mcp-smoke.ts` — `` `Bearer ${token}` ``（命令行参数）
- `server/src/lib/logger.ts` — 脱敏正则 `/(bearer\s+)([a-z0-9._-]{8,})/gi`

### 2. 常见密钥前缀

```bash
$ grep -rn --exclude-dir={node_modules,node_modules.old,dist,.git} \
    -E "(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})" .
[exit=1]        # 无匹配
```

**结果：0 命中。**

`LLM_API_KEY` 在所有代码路径里都是从 `process.env` 读取，`.env.example` 里是空值：

```bash
$ grep -n "LLM_API_KEY" server/.env.example
LLM_API_KEY=
```

### 3. `.env` 是否被误提交

```bash
$ find . -name ".env" -o -name ".env.*" | grep -v node_modules
./server/.env.example
```

**结果：只有 `.env.example`（模板，全部为空值或占位说明）。**

`.gitignore` 已覆盖：

```gitignore
.env
.env.*
!.env.example
```

注意 `!.env.example` 必须写在 `.env.*` **之后**，否则模板文件本身会被忽略（Git 规则：后出现的模式优先）。

### 4. 数据库文件

```bash
$ find . \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \
        -o -name "*.db-wal" -o -name "*.db-shm" \) \
    -not -path "*/node_modules/*" -not -path "*/node_modules.old/*"
（空输出）
```

**结果：0 命中。**

数据库尚未创建（服务未启动过）。`.gitignore` 已覆盖 `*.db` / `*.db-wal` / `*.db-shm` / `*.sqlite` / `*.sqlite3`，
以及 `server/data/`、`data/` 整个目录。

> ⚠️ `*.db-wal` 和 `*.db-shm` 必须单独列出。SQLite WAL 模式下，未 checkpoint 的数据在 `.db-wal` 里 ——
> 只忽略 `*.db` 会把用户 Token 密文和记忆数据一起泄露出去。

### 5. 用户数据 / 备份

```bash
$ find . -type d \( -name "data" -o -name "backup" -o -name "backups" \) -not -path "*/node_modules*"
./server/src/data

$ find . -name "*.bak" -not -path "*/node_modules*"
（空输出）
```

**结果：唯一命中是 `server/src/data`，这是静态知识数据，不是用户数据。**

该目录内容全部是硬编码的节气/星座/情绪策略/离线菜单，可以公开：

```
server/src/data/solar-terms.ts         二十四节气表
server/src/data/star-signs.ts          十二星座表
server/src/data/mood-strategies.ts     6 类情绪策略
server/src/data/mercury-retrograde.ts  水逆时段
server/src/data/offline-menu.ts        离线兜底菜单
```

运行时用户数据目录是 `server/data/`（由 `DATA_DIR` 控制），已被 `.gitignore` 忽略。

> 这个 `data` vs `src/data` 的命名重叠是个隐患：容易被 `grep data/` 误判。
> 已在 `.gitignore` 里用 `server/data/` 而非裸 `data/` 精确限定，避免误伤 `src/data`。

### 6. 日志

```bash
$ find . -name "*.log" -not -path "*/node_modules*"
（空输出）
```

**结果：0 命中。**

`.gitignore` 覆盖 `*.log`、`logs/`、`npm-debug.log*`、`pm2-*.log`。
pm2 的日志目录 `server/logs/` 也在忽略范围内。

### 7. 长 hex 疑似密钥（额外补充）

```bash
$ grep -rn -E "[0-9a-fA-F]{32,}" --include="*.ts" --include="*.js" \
    --include="*.json" --include="*.md" --include="*.html" --include="*.conf" \
    server/src server/tests server/scripts web docs nginx tasks \
  | grep -v "sha256\|hex 32\|rand -hex"
（空输出）
```

**结果：0 命中。**

特意排查这一类，因为 `JWT_SECRET` / `TOKEN_ENC_KEY` 都是 hex 字符串，
如果有人图省事把生成结果粘进测试文件或文档，这条能抓到。

`server/src/config.ts` 里的测试密钥是明确的假值：

```ts
if (isTest) return 'test-secret-key-at-least-32-characters-long!!';
if (isTest) return Buffer.alloc(32, 7);
```

且只在 `NODE_ENV === 'test'` 生效，生产环境缺失会直接 `process.exit(1)`。

### 8. 硬编码 IP / 真实域名（额外补充）

```bash
$ grep -rn -E "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}" \
    --include="*.ts" --include="*.js" --include="*.md" --include="*.conf" server/src web docs \
  | grep -v "127.0.0.1\|0.0.0.0\|192.168\|localhost"
（空输出）
```

**结果：0 命中。** 只有回环地址（`127.0.0.1`）用于本地代理，属正常。

`nginx/mcd-soulmate.conf` 里的域名全部是占位符 `your-domain.com`，
部署路径全部是 `/var/www/mcd-soulmate`（示例值，有注释说明需替换）。

---

## 代码层面的强制保障

审计能通过不是靠"记得别写错"，而是代码结构上就不给泄露的机会：

### 1. Token 加密落库

```ts
// server/src/lib/crypto.ts
// 格式：base64(iv12 || tag16 || ciphertext)，AES-256-GCM
export function encryptToken(plain: string): string { ... }
```

`users.token_enc` 存的是密文，`users.token_fp` 只存 sha256 前 8 位（用于排查，不可逆推）。

### 2. 日志统一脱敏

```ts
// server/src/lib/logger.ts
const SENSITIVE_PATTERNS = [
  /(bearer\s+)([a-z0-9._-]{8,})/gi,
  /("token"\s*:\s*")([^"]{8,})/gi,
  /\b[a-f0-9]{40,}\b/gi,          // 长 hex（可能是 token 或密钥）
  /\bsk-[a-z0-9]{16,}\b/gi,
];
```

所有日志出口都过 `sanitize()`，`mask()` 只显示前 4 + 后 4 位。

### 3. 环境变量强校验（缺失即拒绝启动）

```ts
// server/src/config.ts
if (!v) return fail('JWT_SECRET 未设置（生成方式：openssl rand -hex 32）');
if (v.length < 32) return fail(`JWT_SECRET 太短（${v.length} 字符），至少 32 字符`);
if (!/^[0-9a-fA-F]{64}$/.test(v)) return fail('TOKEN_ENC_KEY 格式错误：需要 64 位 hex');
```

**绝不带病启动** —— 配置错误时直接 `process.exit(1)` 并打印缺失项，
不会出现"用默认弱密钥跑起来了"这种最危险的情况。

### 4. 错误 message 不含 Token

`AppError` 系列只在 `message` 里放用户可读文案，
MCP 原始错误经 `mapMcpError()` 转成固定文案后才外露，
`toApiError()` 对 `INTERNAL` 类型只返回"服务器出了点问题"，不返回堆栈。

---

## 提交前的最后一道人工检查

自动化扫不出"截图里有 Token"这类问题。提交前请本人确认：

- [ ] README 里所有截图：Token 输入框是空的，或已打码
- [ ] 录屏里没有露出完整 Token（输入时用 `type="password"` 已自动遮蔽，但粘贴瞬间可能可见）
- [ ] 演示用的 `.env` 没有被截图/复制到 issue 或聊天记录里
- [ ] 如果曾经把真实 Token 发给过任何人（包括 AI 助手），**去 open.mcd.cn 重置一次**
- [ ] 服务器上的 `.env` 权限：`chmod 600 server/.env`
- [ ] `git log -p | grep -i "token\|secret"` 再确认一遍历史（如果已经 push 过）

---

## 密钥轮换 SOP（万一泄露）

按顺序执行，不要跳步：

```bash
# 1. 重新生成服务端密钥
openssl rand -hex 32   # → 新的 JWT_SECRET
openssl rand -hex 32   # → 新的 TOKEN_ENC_KEY

# 2. 更新 server/.env

# 3. ⚠️ 更换 TOKEN_ENC_KEY 会导致所有已存 Token 无法解密
#    所有用户需要重新粘贴 Token 登录（记忆数据仍在，按 userId 关联）

# 4. 重启服务
pm2 reload ecosystem.config.js --update-env

# 5. 更换 LLM_API_KEY（在模型服务商控制台吊销旧的）

# 6. 麦当劳 Token 无法由我们重置 —— 需要用户本人去 open.mcd.cn 重新生成
#    因此：泄露的如果是用户 Token，必须尽快通知用户

# 7. 如果已 push 到公开仓库，光删文件没用，历史里还在：
#    git filter-repo --path server/.env --invert-paths
#    或者直接删库重建（小项目更快更彻底）
```

---

## 附：真实联调中发现并修复的 4 个 Bug（上线前必读）

以下每一个都是**用真实后端跑 HTTP 链路**才暴露出来的，单元测试和 mock 全部漏过。
记录下来，因为它们代表四类容易复发的坑。

### Bug 1 — `req.on('close')` 导致 SSE 一个事件都发不出去

**现象**：`POST /api/chat` 返回 200 且 SSE 头完全正确，但 body 是 0 字节，
连接一直挂着直到 Nginx/curl 超时。前端表现为"卡在第一步没有反应"。

**根因**：Node 22 / Express 5 下 `req` 的 `'close'` 事件表示**请求体读完了**，
在 `express.json()` 消费完 body 时就立刻触发（实测 0ms）。把它当作"客户端断开"
的信号，会让 `closed` 在流水线启动前就变 `true`：

```ts
// ❌ 错的
req.on('close', () => { closed = true; ctrl.abort(); });
for await (const e of runChat(...)) {
  if (closed) break;   // 第一轮就 break，什么都没写到 res
}
// finally 里 if (!closed) res.end() 也被跳过 → 连接永挂
```

**修复**：断连检测挂到 `res` 上。`res` 的 `'close'` 才是"响应流终结"。

```ts
// ✅ 对的
res.on('close', () => { closed = true; ctrl.abort(); });
```

**教训**：SSE / 长连接场景，判断"对端还在不在"一律看 `res`，不看 `req`。

---

### Bug 2 — 麦当劳 Token 失效被报成 500 INTERNAL，用户看到技术报错

**现象**：Token 过期后确认下单，用户收到
`{"error":"INTERNAL","message":"Streamable HTTP error: Error POSTing to endpoint: 当前鉴权码不存在或已失效!"}`
——一句英文技术栈报错，既没有引导，也不符合契约。

**根因**：MCP 的鉴权错误文案是**中文**的，而 `mapMcpError()` 只匹配英文关键词
（`unauthor|forbidden|token`）。中文文案一路穿透到兜底分支
`new AppError('INTERNAL', msg, 500)`，把内部错误原样透给了用户。

**修复**：新增 `looksLikeAuthError()`，中英文全覆盖，并在 `gateway.ts` 的
`isError` 分支里同样使用。

```ts
if (/鉴权|授权码|登录态/.test(text)) return true;
if (/(token|令牌|凭证)\s*已?\s*(无效|失效|过期|不存在)/i.test(text)) return true;
```

**为什么重要**：契约 §3 要求 401/403 → `TOKEN_INVALID`（前端据此引导"重新粘贴 Token"，
是可自愈的）；500 则意味着"服务挂了"，用户只会干等。这两条路径的**产品结果完全不同**。

---

### Bug 3 — 契约路径 `/api/me`、`/api/profile` 与实现不一致

**现象**：`GET /api/me` → 404。前端登录后立刻白屏。

**根因**：`authRouter` 把 `/me`、`/profile` 和其他 `/auth/*` 接口注册在同一个 router 里，
该 router 被挂载到 `/api/auth`，实际路径变成 `/api/auth/me`。但契约 §1.4/§1.5
规定的是 `/api/me`、`/api/profile`，前端也按契约写的。

**修复**：拆出 `meRouter` 单独挂到 `/api`：

```ts
app.use('/api/auth', authRouter);   // login / logout / unbind
app.use('/api', meRouter);          // GET /api/me、PUT /api/profile
```

**教训**：契约冻结后，**router 挂载点就是契约的一部分**。写路由时先看契约路径前缀，
不要按功能分组后就忘了挂载点会改变最终 URL。

---

### Bug 4 — 解绑后残留 JWT 返回 400，前端卡在中间态

**现象**：用户点"解绑并删除全部数据"后，用旧 Cookie 再访问 `/api/me` 返回
`400 BAD_REQUEST 账号不存在`。前端把 400 当参数错误，既不跳登录页也无法重试。

**根因**：解绑删除了 `users` 行，但 JWT 仍在有效期内（7 天），签名校验能通过，
`GET /api/me` 里 `if (!row) throw new BadRequestError('账号不存在')` 用了错误的错误类型。

**修复**：改用 `UnauthorizedError`（401）。401 才会触发前端清 Cookie + 回登录页。

```ts
if (!row) throw new UnauthorizedError('账号已解绑，请重新粘贴 Token');
```

**教训**：凡是"身份主体已不存在"，都是 401，不是 400。400 表示"你这次请求的参数有问题"，
语义完全不同，前端的分支处理也完全不同。

---

### 这 4 个 Bug 的共同点

都不是逻辑错误，而是**边界语义错误**：事件语义（req vs res）、错误语义（401 vs 500）、
路径语义（挂载点）、状态语义（401 vs 400）。

单元测试测的是"函数算得对不对"，这四类问题只能靠**打真实 HTTP 请求**发现。
所以 `scripts/preflight.sh` 之外，上线前务必手工跑一遍
`README.md` 里的「5 分钟冒烟」流程。
