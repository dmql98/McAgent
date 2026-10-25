# MCP 集成说明

> 本文说明「麦门知己」如何实际接入麦当劳 MCP、调用了哪些工具、调用流程如何编排，
> 以及这些调用对用户产生了什么业务价值。
>
> 全部内容基于 2026-10-24 的真实联调结果，不是设计稿。
> 实测原始记录见 [`docs/mcp-live-report.md`](docs/mcp-live-report.md)，
> 服务端 35 个工具的完整 schema 见 [`docs/mcp-tools-full.json`](docs/mcp-tools-full.json)。

---

## 一、接入的 MCP Server

| 项 | 值 |
|---|---|
| Server | 麦当劳中国官方 MCP Server |
| 端点 | `https://mcp.mcd.cn` |
| 传输协议 | **Streamable HTTP**（MCP 规范 2025-03-26 版本） |
| 认证方式 | `Authorization: Bearer <用户 MCP Token>` |
| Token 获取 | [open.mcd.cn](https://open.mcd.cn) → 手机号登录 → 控制台激活 → 复制 |
| SDK | `@modelcontextprotocol/sdk`（官方 TypeScript SDK） |
| 服务端实际声明工具数 | **35 个**（实测，远超官方文档早期列的 13 个） |

### 客户端接入代码

连接由 `server/src/mcp/gateway.ts` 统一管理：

```ts
const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpEndpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'mcd-soulmate', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
```

### 一个关键设计：Token 由服务端代持，不在前端出现

用户只在登录页粘贴一次 Token，之后：

1. 服务端用 **AES-256-GCM** 加密后落库，密文格式 `base64(iv12‖tag16‖ciphertext)`；
2. 后续每次调用前在内存中解密，注入到 MCP 请求头；
3. 前端只持有一个 `httpOnly` 的会话 Cookie，**JS 读不到 Token**。

这样做的业务意义是：Token 就是用户的麦当劳账号身份，
只有它不出浏览器、不进日志，才谈得上"AI 用你自己的会员账号帮你点餐"。

---

## 二、实际调用的 MCP Tool 清单

按「这条工具在流程里干什么」分组。**标注「已实测」的均在 2026-10-24 用真实 Token 跑通。**

### 2.1 点餐主链路（核心 13 个）

| # | Tool | 环节 | 入参要点 | 缓存 | 实测 |
|---|---|---|---|---|---|
| 1 | `now-time-info` | 登录校验 Token / 判断当前可售餐段 | 无 | 30s | ✅ |
| 2 | `query-nearby-stores` | 到店自取门店检索 | `beType=1` + `searchType=2` + `city` + `keyword` | 5 min | ✅ |
| 3 | `delivery-query-addresses` | 外送地址列表 | 无 | 5 min | ✅ |
| 4 | `delivery-create-address` | 新增外送地址（写） | 地址字段 | 永不 | ✅ |
| 5 | `delivery-query-stores` | 按 addressId 查可配送门店 | `addressId` | 5 min | ✅ |
| 6 | `query-meals` | 拿门店 + 餐段的可售菜单 | `storeCode` + `orderType` + `beType`（到店不传 beCode） | 10 min | ✅ |
| 7 | `query-meal-detail` | 单品详情与**特制项可选值** | `code` | 10 min | ✅ |
| 8 | `list-nutrition-foods` | 热量叙事 | 无 | 24 h | ✅ |
| 9 | `available-coupons` | 用户可领券 | 无 | 5 min | ✅ |
| 10 | `query-store-coupons` | 门店券 | `storeCode` + `orderType` + `beType` | 5 min | ✅ |
| 11 | `auto-bind-coupons` | 自动领券（写） | 无 | 永不 | ✅ |
| 12 | `calculate-price` | **下单前价格复核**（服务端永不信前端金额） | `storeCode` + `orderType` + `beType` + `items[]` | 不缓存 | ✅ |
| 13 | `create-order` | 建单，返回支付链接 | `storeCode` + `orderType` + `items[]` + `takeWayCode` | 永不 | ✅ |

### 2.2 交易闭环（3 个）

| # | Tool | 环节 | 说明 | 实测 |
|---|---|---|---|---|
| 14 | `query-order` | 支付后轮询进度 | 前端 3s→10s 退避；页面进后台暂停轮询 | ✅ |
| 15 | `cancel-order` | 取消订单（写） | 状态立即同步本地库 | ✅ |
| 16 | `order-list` | 历史订单 | 「工具台」里可查 | ✅ |

> **`orderStatus` 实测枚举**（写进了 `docs/contract.md`）：
> `1` 待支付 · `2` 配餐中-已支付 · `4` 配送中 · `6` 已完成 · `7` 已取消 · `8` 已评价 · `10` 配餐中-餐厅确认

### 2.3 「工具台」——把 MCP 能力摊开给用户看（20 个）

这是本项目一个刻意的设计：除了聊天，还有一个页面直接把 MCP 的读取能力做成可点的卡片，
让用户能亲眼看到"数据真的是从麦当劳来的"，而不是 mock。

| 分组 | Tools |
|---|---|
| 账户 | `query-my-account`（积分，含 `currentMouthExpirePoint` 本月将过期）、`query-my-coupons`（卡包券） |
| 优惠 | `available-coupons`、`query-store-coupons`、`query-survey-coupon` |
| 菜单 | `query-meals`、`list-nutrition-foods` |
| 订单 | `order-list`、`query-order` |
| 积分商城 | `mall-points-products`、`mall-product-detail`、`mall-order-list`、`mall-order-detail` |
| 活动 | `campaign-calendar`（当月营销活动日历） |
| 抽奖 | `query-lottery-info`、`query-my-prizes` |
| 主题派对 | `query-party-city`、`query-party-store`、`query-party-store-date` |
| 外送 | `delivery-query-addresses` |

合计：**主链路 13 + 交易 3 + 工具台额外 7 = 23 个工具被真实调用过**，
代码中声明了 35 个工具的完整 catalog（`server/src/mcp/catalog.ts`）。

### 2.4 只读 / 写入的严格分界

写操作必须集中声明，漏一个是真实资损风险：

```ts
export const WRITE_TOOLS = new Set([
  'create-order',        // 建单
  'cancel-order',        // 取消
  'auto-bind-coupons',   // 领券
  'draw-lottery',        // 抽奖
  'mall-create-order',   // 积分商城下单
  'party-order-create',  // 主题派对下单
  'delivery-create-address', // 新增地址
]);
```

这 7 个：**永不缓存**，且 `auto-bind-coupons` 还要求用户口头确认后才允许调用。

---

## 三、调用流程

### 3.1 一次典型对话的完整时序

以用户说「我好烦啊」为例（情绪场景，1 人，不指定门店）：

```
用户输入
  │
  ├─ ⓪ 身份层  验证 JWT Cookie → userId = sha256(token)[0:16]
  │            从库中取密文 Token → 内存解密（不落日志）
  │
  ├─ ① 意图层  规则引擎解析：情绪=烦躁 / 人数=1 / 预算=记忆默认 / 忌口=记忆
  │            置信度 <0.4 才让 LLM 兜底（通常不需要）
  │
  ├─ ② 知识层  【无 MCP 调用】节气表 + 星座表 + 水逆表 + 时段判断
  │            今天 = 霜降第 2 天，水逆第 3 天，生日明天
  │
  ├─ ③ 选品层  【无 MCP 调用】确定性打分
  │            +3 节气命中 / +3 本命 / +2 情绪匹配 / +2 习惯 / -5 avoid
  │            忌口硬过滤（含忌口的商品直接剔除，不参与排序）
  │            ⚠️ 到这里还没有联过网 —— 所以断网也能出菜单
  │
  ├─ ④ 校准层  ★ MCP 调用开始
  │            query-nearby-stores  → 定位门店（优先记忆里的常去店）
  │            query-meals          → 拿该店该餐段可售清单
  │            available-coupons    → 查可用券（失败不阻塞）
  │            list-nutrition-foods → 热量（失败不阻塞，拿不到就不写）
  │            query-meal-detail    → 主推品的特制项（去冰等真实可选值）
  │            ↳ 用真实价格覆盖本地估算
  │
  ├─ ⑤ 表达层  LLM 只写 hook / quote 两句话
  │            LLM 挂了 → 走 prompts/fallbacks.ts 模板，菜单不变
  │
  └─ ⑥ 交易层  用户点「确认下单」后才继续：
               calculate-price → 服务端复核金额（覆盖前端传来的任何数字）
               create-order    → 返回 payH5Url
               query-order     → 轮询进度（3s→10s 退避）
```

**一次情绪对话的 MCP 调用量：约 5 次**（`now-time-info` 在登录时已调过）。
远低于平台 600 req/min 的限额，代码里仍做了限流 —— 因为多人同时用会撞。

### 3.2 下单链路（严格三段式）

```
① 报价  calculate-price  → 拿到 productPrice / discount / price（单位：分）
                          ↓
② 确认  前端弹出确认条，复述「什么单、多少钱、哪家店、怎么取」
        用户点「确认」才继续（不确认绝不建单）
                          ↓
③ 建单  create-order  → 返回 orderId + payH5Url
                          ↓
④ 支付  ★ 把 payH5Url 透传给用户，由用户本人完成支付
        ★ 代码库中没有任何支付/退款实现路径
                          ↓
⑤ 跟踪  query-order  → 状态映射 → 前端卡片实时更新
```

**为什么必须先 `calculate-price`**：前端传来的金额永远不可信。
服务端拿到 `items[]` 后自己算一遍，如果和前端展示的不一致，
以服务端为准并提示用户，绝不按前端数字建单。

### 3.3 到店 / 外送的参数规则（错一个就报错）

这是实测踩出来的，写进了 `catalog.ts` 和编排器注释：

| 场景 | `beType` | `orderType` | `beCode` |
|---|---|---|---|
| 到店自取 | 1 | 1 | **不传**（传了会报错） |
| 得来速 | 5 | 1 | 必传（来自 `query-nearby-stores`） |
| 麦乐送（外送） | 2 | 2 | 必传（来自 `delivery-query-stores`） |
| 企业团餐 | 6 | 2 | 必传 |

而且**到店和外送是两套商品编码**：
同一个新地，到店是 `9900008745`，外送是 `902375`，价格也不同。
把外送编码加到到店购物车会被服务端拒绝（实测返回 404），这是正确行为。

### 3.4 特制项（去冰/加辣）的真实取值

不能自己编「去冰」两个字。必须来自 `query-meal-detail`：

```
rounds[].choices[].modification.items[].values[]
  ├─ selectedKey     ← 用户选中时要传的 key
  └─ unselectedKey   ← 用户未选中时，若此项有 unselectedKey，也必须传
```

规则很反直觉但必须遵守：**有 `unselectedKey` 的特调组，组内所有项都要传**，
选中的用 `selectedKey`，没选中的用 `unselectedKey`。漏传会导致特制失效。

---

## 四、工程处理（MCP 用起来容易踩的坑）

### 4.1 连接池：每用户一条长连接

| 参数 | 值 | 理由 |
|---|---|---|
| 池上限 | 50 条 | LRU 淘汰最久未用的 |
| 空闲回收 | 10 分钟 | 定时器扫描 |
| Token 变更 | 比对指纹，自动销毁重建 | 用户换 Token = 换身份 |

不池化的话每次对话都要重新 `connect`，一次握手几百毫秒，体验明显变慢。

### 4.2 缓存分层：只缓存"错了也不致命"的

| 类别 | 缓存 | 理由 |
|---|---|---|
| 菜单 / 门店 / 营养 / 商城 | 5 min – 24 h | 相对静态，省额度 |
| 账户 / 券 / 奖励 / 活动 | 1 – 30 min | 因人因时变化，短 TTL |
| **价格 / 券后价 / 订单状态** | **永不** | 过期价格比慢更糟 |
| **所有写操作** | **永不** | 双保险 |

### 4.3 限流：先于麦当劳的 429 拦下

- 每用户 20 req/min
- 全局 550 req/min（平台 600，留 50 安全边际）
- 限流时**若有缓存则用缓存顶上**，而不是直接报错

### 4.4 错误三分法

| MCP 实际返回 | 映射为 | 降级动作 |
|---|---|---|
| 401 / 403 / `isError` 且文本像鉴权失败 | `TOKEN_INVALID` | 销毁该用户连接池条目，前端弹重新登录 |
| 429 / rate limit | `RATE_LIMITED` | 有缓存用缓存；无缓存提示"缓一分钟" |
| 超时（读 15s / 写 30s）/ 5xx | `MCP_DOWN` | `retriable: true`，走离线兜底菜单 |
| 其他 4xx | 普通 Error | 这是参数 bug，必须能看到完整 message |

超时时间**读写分开**：读 15s 快速失败，写 30s 给足建单时间。

### 4.5 响应格式适配（实测最大的坑）

官方文档说返回 TOON 紧凑格式，实测发现是三种混着来：

| 工具类型 | 实际返回 |
|---|---|
| 大部分工具 | 「markdown 字段说明 + 原始 JSON」混合文本 |
| `list-nutrition-foods` | 真 TOON：`[160]{productName,energyKj,...}: ...` |
| `query-my-coupons` / `available-coupons` / `campaign-calendar` | 纯 markdown 渲染文本，**不是 JSON** |

所以 `decodeToolResult()` 的策略是：**先剥 markdown 头 → 再 JSON.parse → 再试 TOON → 都不行就原样返回并打 debug 日志，绝不猜**。

响应外层统一是 `{ success, code, message, datetime, traceId, data }`，业务数据在 `data`。

### 4.6 字段名的坑（都实测确认过）

| 坑 | 说明 |
|---|---|
| `payH5Url` 不是 `payUrl` | 支付链接的真实字段名 |
| `currentMouthExpirePoint` | 服务端把 Month 拼成 **Mouth**，解析得按 `Mouth` 匹配 |
| `orderId` 可能在 `data.orderDetail.orderId` | 有外层包装 |
| 状态优先取 `orderDetail.orderStatus`（如"待支付"） | 而不是顶层数字码 `"10"` |
| 金额单位不统一 | `calculate-price` 用**分**，`query-meals` / `query-order` 用**元字符串** |
| 经纬度恒为 0 | `query-nearby-stores` 返回的经纬度不可用，定位只能靠 `city + keyword` 文本搜索 |

> 最后一条直接改变了产品形态：没法做"自动定位最近门店"，
> 所以改成了读记忆里的 `usualCity` / `usualKeyword`，首次使用则引导用户给城市。
> **不是降级，是照着真实约束重新设计。**

---

## 五、业务价值：MCP 到底解决了什么

### 5.1 不用 MCP 会怎样

| 环节 | 没有 MCP 的替代方案 | 问题 |
|---|---|---|
| 菜单 | 硬编码商品表 | 新品上不了、下架下不掉、价格一改就错 |
| 价格 | 自己算 | 会员价/券后价/打包费/配送费算不对，下单必失败 |
| 门店 | 用户手输 | 用户不知道 `storeCode`，也无法判断可售时段 |
| 优惠 | 不查 | 用户明明有券却按原价下单，等于白扔钱 |
| 下单 | 跳转 App | 断在最后一步，AI 白干 |
| 营养 | 估算 | 热量说错会误导用户，不如不说 |

MCP 把这六件事全部变成了实时、权威、可交易的。

### 5.2 具体的价值增量

**① 价格是真的，不是估的**

一次对话里价格经过三次校准：本地估算 → `query-meals` 真实标价 → `calculate-price` 复核。
用户看到的 ¥39.5 和服务端建单的金额一致，因为建单前又算了一遍。

**② 券是真的用上了**

`available-coupons` + `query-store-coupons` 双查，
「券后实付 ¥39.5 / 原价 ¥50.0」这个差额是 MCP 算出来的，不是编的。

**③ 热量拿不到就不写**

`list-nutrition-foods` 失败时 `nutrition` 字段直接不出现。
菜单里没有「≈720 kcal」这行 —— 宁可少一条信息，不给一条错信息。

**④ 下单是闭环的，但钱不经手**

从「我好烦啊」到一个可支付的订单，全程不跳出对话。
最后一跳是 `payH5Url` —— **付款永远是用户自己完成**，Agent 不碰钱。
这既是麦当劳平台的责任设计，也是本项目的安全底线，
代码库中不存在任何支付/退款实现路径。

**⑤ 断网也不翻车**

这是 Rule-first 架构带来的：选品、情绪、节气全在本地算完，
MCP 只负责最后的价格校准和交易。MCP 挂了会降级到离线兜底菜单，
并在界面明确标注「参考菜单，实时价格待确认」—— 不假装拿到了实时数据。

---

## 六、可复现的验证方式

任何人都可以自己跑这三步，验证 MCP 真的接上了：

```bash
cd server

# 1. 类型检查
npx tsc --noEmit

# 2. 311 个单元测试（含 MCP 适配器的真实响应结构测试）
npm test

# 3. MCP 联调冒烟 —— 传入你自己的 Token，逐个验证工具连通性
npx tsx scripts/mcp-smoke.ts <你的MCP_TOKEN>
```

第 3 步会真实打到 `https://mcp.mcd.cn`，输出每个工具的调用结果与耗时。

另外，启动服务后在「工具台」页面可以逐个点开 MCP 能力卡片，
每张卡片都会显示**这次调用是否命中缓存、花了多少毫秒** —— 数据来源一目了然。

---

## 七、已知限制（如实声明）

1. **写操作实测不完整**：`create-order` 在 2026-10-24 的真实联调中跑通了建单并拿到 `payH5Url`，
   但 `mall-create-order`、`party-order-create`、`draw-lottery` 只做了 schema 适配，
   未做真实资金/积分操作验证。
2. **无法做自动定位**：`query-nearby-stores` 经纬度恒为 0，只能靠城市 + 关键词文本搜索。
3. **单进程限制**：SQLite 写锁 + 内存连接池，`pm2 instances` 必须是 1，不能水平扩容。
4. **平台限额**：麦当劳 600 req/min，本项目自限 550。多人高并发时会先于平台拒绝。
