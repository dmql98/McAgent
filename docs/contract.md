# 「麦门知己」接口契约 v1.0（已冻结）

> 上游：`麦门知己-PRD.html` v2.2 · `麦门知己-架构设计.html` v1.0
> 本文是所有开发工作的**唯一事实来源**。改契约必须改本文 + `server/src/types/contract.ts`，并通知所有相关会话。

## 0. 全局约定

| 项 | 约定 |
|---|---|
| Base URL | 前端同源，路径前缀 `/api` |
| 编码 | UTF-8，请求/响应均 `application/json`（`/api/chat` 响应为 `text/event-stream`） |
| 命名 | **HTTP 层出入参全部 camelCase**；**数据库列名全部 snake_case**；转换在 service 层完成 |
| 金额 | `number`，单位「元」，如 `39.5`。不使用字符串、不使用分 |
| 时间 | ISO 8601 字符串（`2026-10-24` 或 `2026-10-24T22:30:00+08:00`）；时间戳字段用毫秒整数 |
| 认证 | httpOnly Cookie `mcd_sid`（JWT，7 天）。浏览器自动携带，前端不手动放 header |
| 错误 | 统一错误体（见 §0.1），HTTP 状态码 + `error` 字段双表达 |
| 幂等 | `POST /api/orders/confirm` 按 `chatId` 幂等 |

### 0.1 统一错误响应

```json
{ "error": "TOKEN_INVALID", "message": "这个 Token 失效了，去 open.mcd.cn 重新生成一个", "retriable": false }
```

| error | HTTP | 含义 | 前端处理 |
|---|---|---|---|
| `TOKEN_INVALID` | 401 | 麦当劳 Token 失效/被吊销 | 引导重新粘贴 Token |
| `UNAUTHORIZED` | 401 | 未登录或会话过期 | 跳登录页 |
| `BAD_REQUEST` | 400 | 参数非法 | 提示具体字段 |
| `NOT_FOUND` | 404 | 资源不存在 | 提示 + 回列表 |
| `GUEST_LIMIT_REACHED` | 429 | 访客当日额度用尽 | 弹登录引导 |
| `RATE_LIMITED` | 429 | 本服务或麦当劳侧限流 | 提示稍后 + 保留重试按钮 |
| `ORDER_CONFLICT` | 409 | 菜单快照/价格已变或订单状态冲突 | 提示新价格，让用户重新确认 |
| `MCP_DOWN` | 503 | 麦当劳 MCP 不可用 | 走离线兜底或提示稍后 |
| `LLM_FAILED` | 502 | 模型生成失败（服务端内部会降级，一般不外露） | 同 MCP_DOWN |
| `INTERNAL` | 500 | 未预期异常 | 通用提示 |

`retriable: true` 的才显示重试按钮。

---

## 1. API 清单

### 1.1 `POST /api/auth/login` — Token 登录（唯一登录方式）

**请求**
```json
{ "token": "eyJhbGciOi..." }
```

**响应 200**
```json
{ "ok": true, "userId": "a1b2c3d4e5f60718", "isNew": true, "needOnboarding": true }
```
同时 `Set-Cookie: mcd_sid=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`

**响应 401**
```json
{ "error": "TOKEN_INVALID", "message": "这个 Token 失效了，去 open.mcd.cn 重新生成一个" }
```

**服务端逻辑**
1. `token` 长度 < 20 → 400 `BAD_REQUEST`
2. 用该 token 调 MCP `now-time-info` 验证（超时 10s）
   - 401/403 → 401 `TOKEN_INVALID`
   - 超时/网络 → 503 `MCP_DOWN`，`retriable: true`
3. `userId = sha256(token).slice(0, 16)`（小写 hex）— **这是记忆库主键，不可变**
4. AES-256-GCM 加密 token 落 `users.token_enc`，格式 `base64(iv12 || tag16 || ciphertext)`
5. 签发 JWT（`{ sub: userId }`，7d）
6. `isNew` = 本次是 INSERT 而非 UPDATE
7. `needOnboarding` = `users.nickname IS NULL`

> **令牌轮换**：同一用户重新登录且 token 变化时，`userId` 也会变（因为派生自 token）。
> 这是设计取舍：换 token = 新身份 = 新记忆库。前端需在登录成功后提示旧身份数据仍保留在服务端。
> 实现上 `users` 表允许一个 `token_fingerprint` 索引，便于排查。

### 1.2 `POST /api/auth/logout` — 退出（不清数据）

响应 200 `{ "ok": true }`，并清 Cookie。

### 1.3 `DELETE /api/auth/unbind` — 解绑并删除全部数据

响应 200 `{ "ok": true }`
删除 `users` / `memories` / `mood_diary` / `orders` / `chats` 中该 `userId` 的所有行。**不可恢复**，前端必须二次确认（输入"删除"两个字）。

### 1.4 `GET /api/me` — 当前用户

**响应 200**
```json
{
  "userId": "a1b2c3d4e5f60718",
  "profile": { "nickname": "麦小门", "birthday": "1998-10-24", "starSign": "天蝎座", "taboo": ["香菜"] },
  "hasToken": true,
  "needOnboarding": false,
  "autoConfirm": false
}
```
未登录 → 401 `UNAUTHORIZED`。`profile` 在未引导时缺省。

### 1.5 `PUT /api/profile` — 三连问 / 资料修改

**请求**（全部可选，传哪个改哪个）
```json
{ "nickname": "麦小门", "birthday": "1998-10-24", "taboo": ["香菜", "洋葱"] }
```
`birthday` 传入后**服务端自动推算 `starSign` 并入库**，响应里返回：

**响应 200**
```json
{ "ok": true, "profile": { "nickname": "麦小门", "birthday": "1998-10-24", "starSign": "天蝎座", "taboo": ["香菜","洋葱"] }, "needOnboarding": false }
```

### 1.6 `POST /api/chat` — 对话（SSE 流式）

**请求**
```json
{ "message": "我好烦啊", "guest": false }
```
`guest: true` 时不要求登录 Cookie，走内存临时上下文，**每 IP 每日 1 次**。

**响应** `Content-Type: text/event-stream`
必需响应头：
```
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**事件序列（正常）**
```
event: stage
data: {"stage":"intent","text":"让我想想你想吃什么…"}

event: stage
data: {"stage":"knowledge","text":"翻了翻节气和你星座的运势…"}

event: stage
data: {"stage":"menu","text":"正在替你看菜单…"}

event: stage
data: {"stage":"coupon","text":"顺便翻了翻你的优惠券…"}

event: stage
data: {"stage":"compose","text":"给你写点人话…"}

event: reply
data: { ...ChatReply，见 §2... }

event: done
data: {"chatId":"c_9f8e7d6c"}
```

**`delta` 事件（可选）**
LLM 流式输出开场白时推送，前端做打字机效果。没有也可，前端必须能容忍不出现。
```
event: delta
data: {"text":"收到。"}
```

**错误事件**
```
event: error
data: {"error":"TOKEN_INVALID","message":"麦当劳授权过期了，重新登录一下"}
```
推完 error 后服务端关闭流。

**注意事项**
- 每个事件之间空行分隔（`\n\n`），`data` 为单行 JSON（不换行）
- 客户端断开时必须中止后端流水线（不要继续烧 MCP 额度）
- 访客第 2 次请求 → 直接 429 `GUEST_LIMIT_REACHED`（不建流）

### 1.7 `POST /api/orders/confirm` — 确认下单

**请求**
```json
{ "chatId": "c_9f8e7d6c" }
```

**响应 200**
```json
{ "orderId": "ORD20261024001", "payUrl": "https://...", "total": 39.5, "store": "留仙洞店", "reused": false }
```

`reused: true` 表示幂等命中（该 chatId 已有未取消订单，直接返回）。

**响应 409**
```json
{ "error": "ORDER_CONFLICT", "message": "菜单价格刚刚变了（现在 ¥41.0），要按新价格下单吗？" }
```

**服务端逻辑（顺序不可乱）**
1. 校验 `chatId` 属于 `req.userId` → 否则 403 `UNAUTHORIZED`
2. 按 `chatId` 查 `orders`：存在且 `status != canceled` → 直接返回（幂等）
3. 从 `chats` 取菜单快照，校验 `menuHash` 与当前一致性 → 不一致 409
4. 调 `calculate-price` 用**真实当前价**重算 → 与快照差 > 0.01 → 409
5. 调 `create-order` → 拿 `orderId` + `payUrl`
6. 写 `orders`（`status='created'`）
7. 更新 habits（常点单品、预算区间）
8. 返回

**支付边界**：`payUrl` 仅透传展示。**本服务无任何代付/自动支付代码路径。**

### 1.8 `GET /api/orders/:id` — 订单进度

**响应 200**
```json
{ "orderId": "ORD20261024001", "status": "progress", "progressText": "正在为你出餐…", "payUrl": "https://...", "updatedAt": 1761300000000, "total": 39.5 }
```
服务端调 `query-order` 并把原始状态映射为 `OrderStatus`，同时更新 `orders` 表。

**状态映射表**

| MCP 原始值（待联调确认） | 内部 status | progressText |
|---|---|---|
| `created` / `pending` / `unpaid` | `created` | 订单已创建，等你付款 |
| `paid` / `payed` | `paid` | 收到钱了，正在准备 |
| `making` / `processing` / `progress` | `progress` | 正在为你出餐… |
| `completed` / `done` / `finished` | `done` | 可以取餐了 |
| `canceled` / `cancelled` / `closed` | `canceled` | 订单已取消 |

> 联调时必须确认 MCP 的**真实** status 取值，回填此表。

### 1.9 `DELETE /api/orders/:id` — 取消订单

允许 `created` / `paid` 状态取消；`progress` 之后 MCP 会拒绝，原样透传错误为 409。

### 1.10 `GET /api/memory` — 记忆管理页数据

**响应 200**
```json
{
  "cards": [
    {
      "key": "profile", "title": "静态档案", "icon": "👤",
      "lines": ["昵称：麦小门", "天蝎座（10/24 生日快到了）", "忌口：香菜"],
      "entries": [{ "key": "profile.nickname", "label": "昵称：麦小门" }]
    }
  ],
  "updatedAt": 1761300000000,
  "privacyNote": "这些只存在你的账号里，你随时可以删。"
}
```
共 5 张卡片：`profile` / `taste` / `habits` / `moodDiary` / `rituals`，顺序固定。

### 1.11 `DELETE /api/memory/:key` — 删除记忆条目

`key` 为 URL 编码的点路径，如 `taste.topItems.%E9%BA%A6%E9%BA%A6%E9%B8%A1`。
响应 200 `{ "ok": true }`；key 不存在 → 404。

### 1.12 `GET /api/health` — 健康检查

**响应 200** `{ "ok": true, "mcp": "reachable" }`
**不需要登录**，不泄露版本号、不泄露内部地址。

---

## 2. ChatReply Schema

**前端渲染的唯一输入。前端不吃 markdown，按以下字段组件化渲染。**

```ts
interface ChatReply {
  hook: string;            // 懂你开场 2-3 句。**关键词** 包裹 → 前端渲染为 .hook 高亮
  meta: {
    store: string;         // 门店名，如 "留仙洞店"
    slot: string;          // 时段/取餐描述，如 "预约明午 12:00"
    title: string;         // 菜单标题，如 "你的「水逆急救单」"
    fulfillment?: '自取' | '外送' | '堂食';
  };
  menu: Array<{
    name: string;
    spec: string;          // 规格/数量/特制，如 "×2 · 去冰"
    why: string;           // 推荐理由，可为空字符串
    price: number;         // ★ 该项小计（不是单价）
    originalPrice?: number;// 该项小计的原价
    productId?: string;    // MCP 商品 id，下单必需
    modifications?: string[]; // MCP 特制项
  }>;
  total: number;           // 券后实付
  original?: number;       // 原价合计
  budget?: { limit: number; ok: boolean; remaining: number };
  nutrition?: string;      // 热量一句话
  quote: string;           // 情绪收尾金句
  actions: ('confirm' | 'refine' | 'reorder')[];
  upsell?: 'login';        // 访客专属
  dataSource?: 'mcp' | 'cache' | 'offline';
  clarifyOnly?: boolean;   // 反问场景：只有 hook，menu 为空
}
```

### 2.1 关键字段语义（不许含糊）

- **`price` = 该项小计**（单价 × 数量）。前端直接显示，不做乘法。这一条写死。
- `hook` 里的 `**关键词**` 标记是唯一的富文本约定。前端把 `\*\*(.+?)\*\*` 替换为
  `<span class="hook">$1</span>`，其余内容做 HTML 转义。**禁止让服务端返回 HTML**。
- `menu` 为空数组时前端不渲染菜单区（反问场景）。
- `dataSource === 'offline'` 时前端在菜单区顶部加一行黄色提示：
  「参考菜单，实时价格待确认」。

### 2.2 标准示例（场景①「我好烦啊」）

```json
{
  "hook": "收到。**水逆第 3 天**（我记得，你 22 号就开始跟我抱怨代码了），霜降刚过一天，天一冷人就容易烦——这是宇宙的锅，不是你的。",
  "meta": { "store": "留仙洞店", "slot": "夜市 · 现在取", "title": "你的「水逆急救单」", "fulfillment": "自取" },
  "menu": [
    { "name": "新地（巧克力）", "spec": "×1", "why": "甜度抵消 30% 烦躁", "price": 11.5 },
    { "name": "麦辣鸡翅", "spec": "×2", "why": "烦就要吃辣，物理发泄", "price": 16.0 },
    { "name": "冰鲜柠檬水", "spec": "去冰 · 你上次说的", "why": "霜降了还是给你留了点冰的自由", "price": 9.5 },
    { "name": "热可可", "spec": "×1", "why": "霜降限定情绪，热乎的才对", "price": 13.0 }
  ],
  "total": 39.5,
  "original": 50.0,
  "nutrition": "≈ 720 kcal",
  "quote": "宇宙没善待你，但优惠券有。上周四你烦的时候吃了麦麦鸡说治愈——这次加个热可可，霜降嘛，麦门。",
  "actions": ["confirm", "refine"],
  "dataSource": "mcp"
}
```

---

## 3. 记忆数据结构

存 `memories.data`（TEXT/JSON），结构与 `UserMemory` 一致：

```json
{
  "schemaVersion": 1,
  "version": 7,
  "profile": { "nickname": "麦小门", "birthday": "1998-10-24", "starSign": "天蝎座", "taboo": ["香菜"] },
  "taste": { "sweetness": 3, "spicy": 2, "temp": ["冰"], "topItems": ["麦麦鸡", "新地", "可乐"], "customs": ["可乐去冰"] },
  "habits": { "orders": [], "budgetRange": [25, 45], "usualSlots": ["下午茶", "夜市"], "usualStore": "留仙洞店" },
  "moodDiary": [{ "date": "2026-10-23", "mood": "烦躁", "trigger": "代码又崩了", "recommended": "麦麦鸡套餐", "feedback": "治愈" }],
  "rituals": { "lastSolarTerm": "霜降", "retrograde": { "active": true, "startDate": "2026-10-22", "dayIndex": 3 }, "birthdayReminder": "2026-10-24" },
  "updatedAt": 1761300000000
}
```

### 3.1 摘要去重规则（上限即契约）

| 字段 | 上限 | 超限策略 |
|---|---|---|
| `taste.topItems` | 5 | 按频次降序，同频按最近时间，截断尾部 |
| `taste.customs` | 10 | 保留最近 |
| `habits.orders` | 50 | 丢最旧 |
| `moodDiary` | 30 | 丢最旧；同一天同一 mood 只保留一条（覆盖） |
| 任意字符串字段 | 200 字符 | 截断 |
| 整体 JSON | 8 KB | moodDiary 裁到 10 条，并打 warn |

`schemaVersion` 用于未来迁移；`version` 每次 save 自增（乐观锁）。

---

## 4. MCP 工具约定

详见 `docs/mcp-tools.md`。三条硬规则：

1. **只读白名单才缓存**。写操作（`create-order` / `cancel-order` / `auto-bind-coupons`）永不缓存。
2. **写操作前必须确认**。`create-order` 前复述菜单+价格+取餐方式；`auto-bind-coupons` 前口头确认。
3. **401 / 429 / 5xx 三分法**。分别映射 `TOKEN_INVALID` / `RATE_LIMITED` / `MCP_DOWN`，降级策略不同。

**限流**：平台 600 req/min。本服务每用户 20 req/min，全局 550 req/min，先于麦当劳 429 拦下。

---

## 5. 安全红线（每条都要能通过 code review）

1. Token 绝不明文落库、绝不进日志、绝不进错误 message、绝不进 git
2. 日志统一走 `lib/logger.ts` 的 `sanitize()`，token 显示为 `abcd****wxyz`
3. 服务端**永不相信前端传来的金额**：一律用 `calculate-price` 或快照重算
4. 一切读写强制校验 `req.userId` 归属
5. 用户输入只作为 data 进 prompt，system/role 固定，不做模板拼接
6. SQLite 全参数化查询
7. 无任何自动支付代码路径，`payUrl` 仅透传
8. 全站 HTTPS（部署硬要求）

---

## 6. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-24 | v1.0 | 初版冻结。确定 `price` = 小计、`hook` 用 `**x**` 标记、SSE 五个 stage |
