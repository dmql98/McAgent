# 麦当劳 MCP 工具速查表

> 端点：`https://mcp.mcd.cn`（Streamable HTTP）· 认证：`Authorization: Bearer <用户token>`
> 限流：平台 600 req/min · 本服务每用户 20 req/min
> 状态：**参数列为设计预期，标 ⚠️ 的需联调实测确认**

## 1. 工具清单

| # | 工具名 | 用途 | 只读 | 缓存 TTL | 阶段 |
|---|---|---|---|---|---|
| 1 | `now-time-info` | 当前时间、可售时段 | ✅ | 不缓存 | 定位 |
| 2 | `query-nearby-stores` | 附近门店（自取） | ✅ | 5 min | 定位 |
| 3 | `delivery-query-stores` | 可外送门店 | ✅ | 5 min | 定位 |
| 4 | `query-meals` | 指定门店+时段的可售菜单 | ✅ | 10 min | 选品 |
| 5 | `query-meal-detail` | 单品详情、套餐组成、特制项 | ✅ | 10 min | 选品 |
| 6 | `list-nutrition-foods` | 营养/热量 | ✅ | 24 h | 叙事 |
| 7 | `available-coupons` | 用户可用券 | ✅ | 不缓存 | 优惠 |
| 8 | `query-store-coupons` | 门店券 | ✅ | 5 min | 优惠 |
| 9 | `auto-bind-coupons` | 自动领券 | ❌ **写** | 永不 | 优惠 |
| 10 | `calculate-price` | 价格试算（下单前复核） | ✅ | 不缓存 | 交易 |
| 11 | `create-order` | 建单，返回支付链接 | ❌ **写** | 永不 | 交易 |
| 12 | `query-order` | 订单状态 | ✅ | 不缓存 | 交易 |
| 13 | `cancel-order` | 取消订单 | ❌ **写** | 永不 | 交易 |

> `available-coupons` / `calculate-price` / `query-order` 虽然只读但**结果因人因时变化**，
> 不进缓存（缓存会给出过期价格，风险高于收益）。

## 2. 分阶段使用说明

### 2.1 定位
- `now-time-info` → 确认当前时段、判断哪些餐段可售（早餐/午餐/下午茶/夜市）
- `query-nearby-stores` / `delivery-query-stores` → 按 fulfillment 二选一
  - 优先用记忆里的 `habits.usualStore` 匹配门店名，命中则直接用
  - 未命中取最近一家

### 2.2 选品
- `query-meals`（入参含 storeId + 时段）→ 拿可售清单
- 对选中的 1–2 个主推品调 `query-meal-detail` → 拿特制项（去冰/加辣/去酱）
- **特制项必须来自 detail 返回的真实 modification 列表**，不许自己编 "去冰"

### 2.3 叙事
- `list-nutrition-foods` → 热量
- **失败不阻塞**：拿不到就不写 `nutrition` 字段，不要瞎算

### 2.4 优惠
- `available-coupons` → 用户可用券
- `auto-bind-coupons` → **必须口头确认后才能调**（PRD §7 领券确认制）

### 2.5 交易
- `calculate-price` → 下单前**必调**，用真实价格复核（服务端永不信前端金额）
- `create-order` → 返回 `orderId` + `payUrl`
- `query-order` → 轮询进度
- `cancel-order` → 取消

## 3. 错误处理

| MCP 返回 | 映射 | 处理 |
|---|---|---|
| 401 / 403 | `AuthError` → `TOKEN_INVALID` | 销毁该用户连接池条目，前端弹重新登录 |
| 429 | `RateLimitError` → `RATE_LIMITED` | 有缓存用缓存，无缓存提示稍后 |
| 超时（15s，写操作 30s） | `McpDownError` → `MCP_DOWN` | `retriable: true`，走离线兜底 |
| 5xx | `McpDownError` | 同上 |
| 4xx（其他） | 普通 Error | 这是参数 bug，要能看见完整 message |

## 4. ⚠️ 待联调确认清单

以下 8 条必须在有真实 token 时实测确认，确认后回填本文：

1. **`query-meals` 的入参**：是 `storeId` 还是 `storeCode`？时段参数是枚举字符串还是时间戳？
2. **`query-meals` 返回结构**：商品数组的字段名（`productId`? `code`? `id`?）、
   价格字段是原价还是活动价、是否含券后价
3. **`query-meal-detail` 的 modification 结构**：特制项的可选值列表在哪一层？
   去冰/加辣的实际取值是什么字符串？
4. **`calculate-price` 的入参**：是否需要完整 items 数组？返回结构是 `{total, original, discount}` 吗？
   是否直接包含券后价？
5. **`create-order` 的入参**：是否需要 `storeId` + `items[]` + `fulfillment` + 联系人信息？
   套餐内的可选饮品怎么表示（子项）？
6. **`create-order` 的返回**：`orderId` 字段名、`payUrl` 字段名、是否有有效期 `expiresAt`
7. **`query-order` 的 status 取值全集**：真实字符串有哪些？回填 `docs/contract.md` §1.8 映射表
8. **`payUrl` 的形式**：是网页链接、H5 支付页、还是需要渲染的二维码图片 URL？
   这决定前端支付卡片怎么展示

### 4.1 TOON 格式
MCP 响应用 TOON 紧凑格式。实现策略（`server/src/mcp/toon.ts`）：
1. 先试 `JSON.parse`
2. 失败则按 TOON 规则解析（缩进层级 + 逗号分隔 + 无引号键）
3. 仍失败 → 原样返回字符串 + 打 debug 日志，**不猜**

> 联调时把一段真实响应贴进本文附录，作为 TOON 解析器的测试用例。
