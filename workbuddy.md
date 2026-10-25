# workbuddy.md

本文件记录「麦门知己」使用 **腾讯 WorkBuddy** 开发的对话上下文与开发主线，
用于核验本项目真实使用 WorkBuddy 智能体完成开发。

> **说明**：第三部分的日志是 WorkBuddy 在每个工作日结束时自动落盘的开发记录
> （`.workbuddy/memory/YYYY-MM-DD.md`），原样收录，不是事后按项目成果倒推补写的总结。
> 已脱敏：真实 Token、密钥、本机绝对路径、手机号、收货地址、订单号均已替换为占位符。
> 宿主系统提示、隐藏推理、工具调用原始报文不包含在导出的日志里。

---

## 一、开发环境

| 项 | 值 |
|---|---|
| 开发平台 | 腾讯 WorkBuddy |
| MCP 接入 | 自定义连接器 `mcd-mcp`（Streamable HTTP，`https://mcp.mcd.cn`）|
| 项目形态 | Web 应用（Node.js 22 + Express 5 + TypeScript + SQLite / Vue 3 + Vite）|
| 运行方式 | 本机 `localhost:3000`，Node 直接跑 `dist`，无容器 |
| 开发周期 | 2026-10-24 ~ 2026-10-25（两个完整工作日）|
| 日志位置 | `.workbuddy/memory/2026-10-24.md`、`2026-10-25.md`（随仓库一同提交）|

### 我与 WorkBuddy 的分工

这个项目不是"让 AI 生成代码然后复制粘贴"。实际的分工是：

- **我负责**：产品判断（要做"接住情绪"而不是又一个算账机器人）、
  每次实测点餐后的真实反馈（哪份菜单不合理、哪个金额不对）、
  卡住时决定方向（比如"开局必须先选到店/外送"这条硬约束）。
- **WorkBuddy 负责**：读代码定位根因、写实现、跑测试、用真实 Token 打 MCP 验证、
  把每次踩的坑写进日志和文档。

这个分工在下面的日志里看得很清楚：每一条 bug 都来自我的一句
「这个套餐已经有汉堡了，单人吃不了那么多」这类**真实抱怨**，
而不是"帮我检查一下代码"。

---

## 二、开发主线

### 阶段 1 · 任务拆分与契约冻结（10-24 上午）

读完已有的 PRD、架构设计、开发计划四份文档后，WorkBuddy 把项目拆成
T0 + M1~M7 共 8 个可独立执行的里程碑，并冻结了四条硬约束：

1. **T0 契约先行**：API / SSE / 回复 JSON 三份契约先定死，之后并行开发只靠契约，不靠口头约定
2. **规则做「想」、LLM 只做「说」**：选品/报价/情绪分类全部静态规则，LLM 仅润色 hook/quote
3. **`price` 语义定死为「该项小计」**，不是单价
4. **`instances: 1`**：SQLite 写锁 + 内存连接池，不能开集群

> 第 2 条是后面所有"演示不翻车"的来源：LLM 挂、MCP 挂、断网，
> 菜单依然是对的。这个决定在当天就被验证有价值了。

### 阶段 2 · MCP 实测：发现服务端有 35 个工具（10-24）

用真实 Token 连上 `mcp.mcd.cn` 后，第一个发现就是**文档和现实不一致**：
官方文档只列了 13 个工具，服务端实际声明 **35 个**。

WorkBuddy 把 35 个工具的完整 schema 全部 dump 成 `docs/mcp-tools-full.json`，
并逐个实测返回结构，写成了 `docs/mcp-live-report.md`。当天确认的关键事实：

- 响应外层统一是 `{success, code, message, datetime, traceId, data}`
- 返回格式**不是**纯 TOON：大部分是「markdown 字段说明 + 原始 JSON」混合文本，
  只有 `list-nutrition-foods` 是真 TOON
- **金额单位不统一**：`calculate-price` 用「分」，`query-meals`/`query-order` 用「元字符串」
- `query-nearby-stores` 的经纬度**恒为 0**，定位只能靠城市 + 关键词文本搜索

> 最后一条直接改变了产品形态：本来想做"自动定位最近门店"，
> 实测后发现做不到，于是改成读记忆里的常用城市/关键词，首次使用则引导用户给城市。
> **这是照着真实约束重新设计，不是降级方案。**

### 阶段 3 · 修「说什么都给同一份菜单」（10-24）

这是本项目最关键的转折点。我反馈「不管说什么都回同一份菜单」，
WorkBuddy 定位到三个叠加的 bug，其中第一个非常微妙：

**`canWithOrder` 语义被曲解（决定性 bug）**

MCP `query-meals` 返回 90 件商品，其中 `canWithOrder=true` 只有 12 件，
且全部是带 `withOrder` + `discountType:"随单购麦金卡优惠"` 的加购套餐。

所以 `canWithOrder` 的真实语义是「**可随单购**（加购优惠项）」，**不是**「可售」。

旧代码把它当可售状态 → 78 件正常单品（板烧鸡腿堡、麦辣鸡翅、薯条、可乐…）全被过滤，
候选池只剩 12 件套餐 → 无论说什么都只推那几份四件套。

修复：`canWithOrder` 改记为新增字段 `withOrderOnly`；可售状态只看
`available`/`isAvailable`/`saleStatus`/`status`。

> 这个 bug 特别值得记：字段名看起来很像"能不能点"，但语义完全不同。
> 只有真实调用、看到 90 件变 12 件，才能发现。

另外两个 bug：
- **选品与渲染的份数不一致**：装箱按单价算预算，渲染又按人数放大份数，
  「4 人 150 块」实际出 546 块账单
- **用户说出的口味偏好完全没参与选品**：`intent.explicit.taste` 从来没被打分用上，
  所以「来点甜的」和「我好烦」选出同一份菜单

修复后：四种意图产出四份不同菜单，「两人 80 块」实付 77.3 准确。

### 阶段 4 · 到店 / 外送必须是开局硬约束（10-24）

我要求「一开始就选到店还是外卖」。这不是 UI 偏好，实测数据支撑：

同一门店，到店 88 个 `productCode` 里有 75 个（**85.2%**）在外送菜单不存在，外送侧 116 个。
**两套编码，中途切换必然建单失败。**

这一轮踩了 5 个坑，其中两个值得写进任何类似项目：

1. **外送预算必须扣掉配送费+打包费再校验**
   第一版拿 `budget` 直接选品，商品价刚好 80，加 6 元配送 + 3 元打包变 89 ——
   用户明确说 80 却给 89。改法：先 `calculate-price` 拿真实总额，
   反推 `feeActual = 实付 − 商品价合计`，再用 `budget − feeActual` 重选一轮（最多一次，省额度）。
2. **Express 5 路由顺序**：`/addresses` 必须早于 `/:id` 注册，否则被通配抢占返 404。

### 阶段 5 · 选品引擎：修「套餐重复配置」（10-24 下半场）

我又给了三条真实抱怨，全部定位到 `selector.service.ts`：

| 我的原话 | 根因 | 修法 |
|---|---|---|
| 「这个套餐已经有汉堡了，单人吃不了那么多」| `roleOf` 不认不含「堡」的套餐、`withOrderPool` 绕过主食上限 | 加 `isCombo`/`servesOf`/`maxMainSku`，三阶段装箱 |
| 「这个两个人又点一个单人餐」| 双人餐打分恒为 0 | 加「人数匹配」+5，`qtyOf` 双人餐按 `ceil(people/serves)` |
| 「一人套餐有饮料啊，但是又点了一杯」| 套餐自带饮料/小食没记账，结构上限以为还欠一杯 | 新增 `comboSlots(p)`，把自带项**记到额度上** |

核心是 `comboSlots()`：有 `combo` 明细就逐项归类，没明细就兜底
「一份餐 = 主食 + 小食 + 饮料」，然后按 `slots × qty` 记到额度上，从根上禁止重复补位。

> 这里有个**被回滚的尝试**值得记：试过把双人餐 `qtyOf` 从 `ceil` 改 `floor`
> （想让 3 人刚好 3 人份），结果更糟 —— 双人餐 ×1 只够 2 人 → 又补一份单人套餐（×3 份）
> → 5 人份、价格翻倍。已回滚并加注释锁定：**`ceil` 多 1 人份远好过点错一顿**。

### 阶段 6 · 购物车侧栏 + 五个真 bug（10-25 上午）

需求：菜单从聊天气泡挪到独立侧栏购物车，支持手动增删 + 对话修改。

到店/外送两条链路都跑通后，修了 5 个 bug（当日日志标题写的是「三个」，
是开工时的判断，实际排查下来是 5 个；这里按最终事实写）。
其中最严重的一个会导致**重复下单**：

**`adaptOrder` 漏解 `data` 包装层**

- 现象：`POST /api/orders/confirm-cart` 返回 409「建单返回看不懂」
- 实际：MCP **已建单成功**（orderId 已生成、状态待支付），但本地判成失败、orders 表 0 行
- 后果：用户以为没下成再点一次 → **两份订单要付两次钱**
- 修复：解 `data`，并兼容 `orderId` 也可能在 `data.orderDetail.orderId`；
  支付链接字段是 **`payH5Url`**（不是 `payUrl`）；状态优先取 `orderDetail.orderStatus`（「待支付」），
  不是顶层数字码 `"10"`
- 新增 `tests/mcp-adapter.test.ts` 7 条，用真实响应结构锁死

> 这个 bug 是本项目风险最高的一处：它不报错、不崩溃，只是安静地让用户多付一次钱。

### 阶段 7 · 架构重构：LLM 主导意图解析（10-25 下午）

我推翻了原来的纯规则意图层，要求「LLM 主导意图解析 + 旁路判断」。
这是对阶段 1 第 2 条原则的一次修正：规则仍管"定价、选品、忌口"这类**必须确定**的事，
但"用户到底想要什么"交给 LLM 更准。

重构后全链路实测通过。测试数量是逐轮长起来的：153 → 164 → 222 → 236（各阶段日志里都有记录），
最终仓库状态为 **311 个用例全绿**（发布前实际执行 `npm test` 的结果）。

### 阶段 8 · 仓库合规清理（10-25 收尾）

准备发布时发现公开仓库里混入了 `server/.env`（含真实密钥）和 `server/data/mcd.db`
（含 12 个用户的加密 Token）—— 密钥与密文同时公开等于加密失效。

处置：补 `.gitignore` → 移除敏感项 → 重建 git 历史 → 强推 → 验证远程返回 404。
并验证了一件容易被忽略的事：**旧 blob 仍可通过 SHA 访问**，删除文件不等于安全，
必须轮换密钥。这套处置流程已写进 `server/.env.example` 顶部注释。

---

## 三、WorkBuddy 开发日志原文（自动落盘，按日归档）

以下两份是 WorkBuddy 在每个工作日结束时自动写入 `.workbuddy/memory/` 的日志，
与仓库中提交的文件一致。日志里保留了当时的判断、试错和被回滚的方案 ——
包括后来被推翻的早期决策，这是真实过程的证据。

### 2026-10-24.md

````markdown
# 2026-10-24

## 麦门知己项目 · 任务拆分与提示词包

读完现有 4 份文件（PRD v2.2 / 架构设计 v1.0 / 开发计划 v1.0 / demo/index.html），
按 M1–M7 里程碑 + 新增 T0 契约冻结，拆成 8 个可独立开新会话执行的任务包。

产出目录：`<项目根目录>\tasks\`

- `README.md` — 任务索引 + 执行顺序 + 并行策略图
- `00-T0-契约冻结.md` — **必须第一个做**：API/SSE/回复 JSON 契约 + contract.ts + web/mock.js + mcp-tools.md
- `01-M1-骨架与登录.md` — monorepo + SQLite + Token 登录全链路 + AES/JWT + 日志脱敏
- `02-M2-知识与记忆.md` — 节气/星座/情绪三表（纯函数）+ memory.service + 单测（可与 M1 并行）
- `03-M3-MCP网关.md` — 连接池 + TTL 缓存 + 令牌桶 + 错误映射 + smoke 脚本
- `04-M4-编排与回复.md` — 意图解析 + 五层流水线 SSE + prompts 五层装配 + 选品打分算法
- `05-M5-前端接线.md` — web 拆分 + 登录/三连问/记忆管理 + SSE 手工解析（mock 优先，最早可开工）
- `06-M6-直下单.md` — confirm 幂等/归属/快照校验 + 支付卡片 + 进度轮询
- `07-M7-部署收尾.md` — 安全审计 grep + Nginx SSE 配置 + pm2 + 备份 + README + 参赛材料

关键设计决策（已写入各任务提示词，不要偏离）：
1. T0 契约先行，之后并行只靠契约，不靠口头约定
2. 规则做"想"、LLM 只做"说"：选品/报价/情绪分类全部静态规则，LLM 仅润色 hook/quote
3. price 字段语义定死为「该项小计」
4. 硬截止：M-CODE 报名 10/25 23:59、Star 排名 10/26 00:00、WaytoAGI 提交 10/25 → M7 优先级高于 M6
- 用用户提供的真实 token 实测麦当劳 MCP（mcp.mcd.cn）：连接成功，服务端实际 35 个工具（文档只记了 13 个）。实测确认券/积分/门店/菜单/详情/门店券/计算价格/订单查询的返回结构，金额单位不统一（calculate-price 用分、query-meals 用元）。新增 docs/mcp-tools-full.json（完整 schema）和 docs/mcp-live-report.md（实测报告）。新增探测脚本 server/scripts/mcp-probe.mjs。写操作（create-order 等）未实测。
- 补测外送链路：delivery-query-addresses（返回账号 10 个收货地址，markdown+JSON）、delivery-query-stores 按 addressId+beType=2 查到厦门可配送门店（返回含 beCode，外送场景必传）。结论：MCP 支持麦乐送外送下单，链路为 查地址→查配送门店→query-meals(orderType=2)→calculate-price→create-order。

## LLM 接入核查 + 「说什么都给同一份菜单」根因修复

**LLM 接入状态**：项目本来就有 OpenAI 兼容客户端（`server/src/services/llm.client.ts`），
`.env` 已配 `LLM_BASE_URL=https://api.openai-next.com/v1` / `LLM_MODEL=deepseek-v4-1-flash-261017`。
实测连通、JSON mode 可用、真实 prompt（~1000 prompt tokens）下 hook/quote 生成稳定，
意图兜底解析 4/4 成功。**LLM 侧没有问题，不需要改接入。**

**用户反馈「说什么都给这个回复」的真正根因（与 LLM 无关，共 3 个 bug）**：

1. **`canWithOrder` 语义被曲解（决定性 bug）** — `mcp-adapter.ts`
   MCP `query-meals` 返回 90 件商品，其中 `canWithOrder=true` 只有 12 件，
   且**全部**是带 `withOrder` + `discountType:"随单购麦金卡优惠"` 的加购套餐。
   所以 `canWithOrder` 是「可随单购（加购优惠项）」，**不是**「可售」。
   旧代码把它当可售状态 → 78 件正常单品（板烧鸡腿堡、麦辣鸡翅、薯条、可乐…）全被过滤，
   候选池只剩 12 件套餐 → 无论说什么都只推那几份四件套。
   修复：`canWithOrder` 改记为新增字段 `withOrderOnly`；可售状态只看 available/isAvailable/saleStatus/status。

2. **选品与渲染的份数不一致 → 预算失效** — `selector.service.ts`
   装箱按**单价**算预算，渲染时又按人数放大份数，导致「4 人 150 块」实际出 546 块的账单。
   修复：抽出 `qtyOf(p, people)` 供选品和 `buildMenuItems` 共用（主食 min(people,4)、饮品/甜品 ceil(people/2)）。
   ⚠️ 份数规则是产品约定，`tests/selector.test.ts` 已锁定，不要改。

3. **用户说出的口味偏好完全没参与选品** — `selector.service.ts` / `intent.service.ts`
   `intent.explicit.taste` 从来没被打分用上，所以「来点甜的」「我要减肥」与「我好烦」选出同一份菜单。
   修复：taste 命中 +4 分（最高权重）；新增 `matchTasteTag`（只匹配商品名，不匹配分类，
   否则「小食甜品/其他」分类会把苹果片判成甜食）、`dislikeOf`（减肥/清淡时高热量降权 -4）、
   `isNonFood`（调味酱/周边/毛绒 -6）。

**附带修复**：
- `intent.service.ts` 的 `hasExplicit` 未含 taste → 说了口味仍被反问「想吃带劲的还是舒服的」。已加上 taste/fulfillment/timeHint。
- 菜单行 `why` 为空（预算补位商品）→ 新增 `whyOf()` 兜底理由。
- 选品新增同类归一化去重（避免同时出现「麦辣鸡腿汉堡」和「麦辣鸡腿堡四件套」）。

**验证**：tsc 0 error；153/153 测试通过；真实 token 端到端，四种意图产出四份不同菜单，
预算「两人80块」实付 77.3 准确。服务以 `node dist/index.js` 运行（改代码后必须 `tsc` 重新编译再重启）。

**遗留**：`orchestrator.ts:266` LLM 生成 hook 仅对已登录且有记忆的用户生效（访客走模板兜底）；
`霜降`等节气 keywords 含「汉堡」这类泛词，+3 分对所有套餐一视同仁，多样性仍可再优化。

## 产出：实际点餐 Agent Loop 文档（HTML）

`麦门知己-点餐Agent-Loop.html`（14 节，代码实证版）。逐行核对 routes/chat.ts、orchestrator.ts、
selector.service.ts、reply.renderer.ts、order.service.ts、mcp/gateway.ts、delivery.service.ts、
intent/knowledge/system prompts、web ChatView.vue 后整理，内容分三块：
1) 全景（五层流水线 + 7 个硬判定 + 边界：这是单请求流水线，不是自由 ReAct，LLM 不选工具）
2) 逐层细节（意图规则表、情绪→选品倾向表、到店/外送两条 MCP 链与 TTL、打分表 +4/+3/-5/-6、
   份数 qtyOf 规则、预算收敛算法、prompt 五层装配、confirm 六道校验、轮询参数）
3) 实现 vs 契约 8 个 GAP（重点，下次改代码可据此排期）：
   - delta 事件从未 yield → 前端打字机永远不生效
   - dataSource 恒 'mcp'，缓存命中仍显示"已实时核对"（协程 meta.cached 没往上传）
   - available-coupons 只触发 stage 动画，券从未参与算价；originalTotal 在 350 行被覆盖两次
   - 「换一换」无排除上一单逻辑，会推同一份菜单
   - 无会话级上下文，每条消息独立解析、独立 chatId，反问后用户回复会被当新句再解析
   - users.auto_confirm 能读写但下单链路不读，免确认未实现
   - 外送划线原价被商品原价覆盖（288 行 vs 350 行）
   - 访客先跑 intent/knowledge 两个 stage 才遇 NEED_LOGIN，登录检查可前置

## 实现：对话开局选「到店 / 外送」全链路

用户要求「在一开始就选到店还是外卖」。这不是 UI 偏好，是硬约束 —— 实测同一门店
到店 88 个 productCode 里 75 个（85.2%）在外送菜单不存在，外送 116 个。中途切换必然建单失败。

**新增文件**
- `server/src/services/delivery.service.ts`：外送唯一入口。`fulfillmentArgs()` 集中翻译
  `Fulfillment → {orderType, beType}`；`listAddresses/pickAddress/createAddress`；
  `resolveDeliveryStore`（按地址换可配送门店，必带 beCode）；`calcDeliveryPrice`（orderType=2 + addressId + beCode）。

**改动文件**
- `mcp-adapter.ts`：`PriceInfo` 增 `deliveryFee/packingFee/minOrder`；新增 `adaptAddresses`（phone 本身已脱敏，别再打码）、`adaptDeliveryStores`。
- `orchestrator.ts`：`RunChatInput` 增 `fulfillment/addressId`；外送先 `pickAddress` 拿不到就抛 `NEED_ADDRESS`；
  `fetchFromMcp` 按履约分支（外送走 delivery-query-stores + query-meals orderType=2/beType=2/beCode）；
  抽出 `resolveNearbyStore` 供 order.service 复用；`persistChat` 扩 5 列。
- `order.service.ts`：`confirmOrder(userId, chatId, opts)`。履约优先沿用 chat 落库值，
  请求显式传且不一致直接 `OrderConflictError`。外送走 `calcDeliveryPrice`（无 takeWayCode），
  到店才要 takeWayCode。`resolveStoreCode` 优先用 chat.store_code。
- `routes/chat.ts`、`routes/orders.ts`：schema 扩 enum；新增 `GET/POST /api/orders/addresses`、`GET /addresses/:id`
  （**必须注册在 `/:id` 之前**，否则被通配抢占返 404）。
- `contract.ts`：`ErrorCode` 增 `NEED_ADDRESS`；`DeliveryFeeInfo/DeliveryAddress/CreateAddressRequest`。
- `db/index.ts`：chats 补 fulfillment/address_id/address_text/store_code/be_code；orders 补前三个。
- 前端 `types.ts`/`api.ts`/`ChatView.vue`：开局双卡选择、地址条常驻输入区上方、内联新建表单、
  对话开始后锁定履约方式（`fulfillmentLocked`，只能「重开对话」换）、回复卡显示配送费/打包费/送达地址。

**踩到的坑（重要）**
1. **外送预算必须扣掉配送费+打包费再校验**。第一版拿 `budget` 直接选品，商品价刚好 80，
   加 6 元配送 + 3 元打包变 89 —— 用户明确说 80 却给 89。改法：先 `calculate-price` 拿真实总额，
   反推 `feeActual = 实付 − 商品价合计`，再用 `budget − feeActual` 重选一轮（最多一次，省额度）。
   修复后同 query 实付 75.5，落在 80 内。
2. `Express 5` 路由顺序：`/addresses` 必须早于 `/:id` 注册。
3. 旧 node 进程占 3000 导致测到旧代码，表现是新加接口返回 `NOT_FOUND` —— 改代码后要确认端口上的进程是新起的。
4. 前端是 **hash 路由**，截图/直连要用 `/#/chat`，写 `/chat` 会拿到后端 JSON 404。
5. 无头 Chrome 的 `--screenshot` 不能设 cookie，登录后页面截不到。改用 CDP
   （`Network.setCookie` + `Page.captureScreenshot`），脚本在 `server/scripts/shot*.mjs`。

**验证**
- `tsc --noEmit` 前后端各 0 error；`npm test` 153/153 通过（份数约定 `min(people,4)`/`ceil(people/2)` 未被破坏）
- 真实 token 双链路：到店 88 件可售 76、算价 ¥61 有 takeWayCode 无配送费；
  外送 116 件可售 107、算价 ¥48.10 = 商品 41.30 + 配送 6.00 + 打包 0.80，无 takeWayList
- 端到端 runChat 两条分支均产出完整菜单，`fulfillment` 未串场，`deliveryFee`/`address` 只在外送出现
- 界面截图 4 张存 `.shots/`：chat-logged（开局选择）、chat-delivery（地址条）、chat-addrform（新建表单）、
  chat-delivery-reply / chat-pickup-reply（两种履约的回复卡对比）

---

## 选品引擎：修「套餐重复配置」（2026-10-24 下半场）

用户三条真实抱怨，逐条定位到 `selector.service.ts`：

1. **「这个套餐已经有汉堡了，单人吃不了那么多」** → `roleOf` 不认不含「堡」的套餐、
   `withOrderPool` 绕过主食上限。→ 加 `isCombo`/`servesOf`/`maxMainSku`，三阶段装箱。
2. **「这个两个人又点一个单人餐」** → 双人餐打分恒为 0。→ 加「人数匹配」+5，`qtyOf` 双人餐按 `ceil(people/serves)`。
3. **「一人套餐有饮料啊。但是又点了一杯」** → 套餐自带的饮料/小食没有记账，
   结构上限以为还欠一杯，于是补了一杯可乐。→ 新增 `comboSlots(p)`：

**核心修复 `comboSlots()`**
- MCP 有 `combo` 明细 → 逐项归类；没明细 → 兜底「一份餐 = 主食 + 小食 + 饮料」。
- `take()` 里按 `slots × qty` 把 `drinks/sides/desserts` **记到额度上**，从根上禁止重复补位。
- `structureCap` 语义从「还能补几份」改成「**总份数**」——这是关键，否则套餐的自带项无处记账。
- `whyOf()` 给套餐补一句「套餐自带饮料和小食」，用户看到菜单里没单列可乐也不会以为漏了。

**顺带修的两个漏点**
- 第 4 轮「预算余量加甜品」自己 `push` + `desserts++`，绕过 `seenCore` 和上限 → 改走 `take()`。
- 第 5 轮兜底 `push` 同样绕过份数 → 改走 `take()`，只保底一次。

**踩的坑（重要）**
- 试过把双人餐 `qtyOf` 从 `ceil` 改 `floor`（想让 3 人刚好 3 人份），**结果更糟**：
  双人餐 ×1 只够 2 人 → 又补一份单人套餐（×3 份）→ 5 人份、价格翻倍。
  已回滚并加注释锁定：`ceil` 多 1 人份远好过点错一顿。
- 诊断脚本里 `feedCapacity` 曾对甜品也求和，误报「够 3 人吃」，已限定只对主食求和。
- 测试夹具太单薄（15 件）看不出效果，另建 `scripts/diag-struct.ts`
  用「接近真实菜单」（含 4 款双人餐 ¥54.9~73.9、草莓新地 ¥13.5 等）体检。

**验证**
- `tsc --noEmit` 0 error；`npm test` **164/164** 通过（新增 10 条「结构合理性」回归，锁定用户三条抱怨）
- `diag-struct.ts` 1-4 人全部「✅ 结构合理」：
  1 人 → 板烧鸡腿堡套餐×1（自带饮+小食）+ 圆筒 + 苹果片，¥51.5，**无第二杯饮料**
  2 人 → 快乐吃鸡双人餐×1 + 圆筒 + 苹果片，¥67.4，**不再点 2 份单人餐**
- 已知取舍：3 人点双人餐会给到 4 人份（`ceil` 所致），已加测试锁定「超额不超过 1 人份」。
````

### 2026-10-25.md

````markdown
# 2026-10-25

## 购物车侧栏改造 — 全链路验证与三个真 bug 修复

用户需求：菜单从聊天气泡挪到独立侧栏购物车，支持手动增删 + 对话修改。

### 验证结论（全部实测通过）

到店 / 外送两条链路都跑通，商品编码严格隔离：

| 场景 | 结果 |
|---|---|
| 到店加购 `9900008745` 新地 ¥13 | ✅ 同商品合并、不同 spec 分行 |
| 到店加购 `1440` 麦辣鸡腿汉堡 ¥22.5 | ✅ |
| 外送加购 `902375` 草莓新地 ¥14.5 | ✅ 外送价 ≠ 到店价（两套编码） |
| 外送编码 `902375` 加到到店车 | ✅ 正确拒绝 404 |
| 外送算价 | ✅ ¥29 商品 + ¥6 配送 + ¥1.6 打包 = ¥36.6 |
| 外送下单 | ✅ orderId 返回，金额与购物车一致 |
| 对话改车 | ✅ 删/加/改数量/换成/清空 五种指令全通 |

对话指令实测：
- 「把新地删了」「把可乐删了」→ 正确删除
- 「再加一杯可乐」→ 加 1 份
- 「汉堡改成两份」→ qty 改 2
- 「把汉堡换成麦乐鸡」→ 数量保留、商品替换
- 「全部清空」→ 清空
- 空车说「把薯条删了」→ 提示「还没点东西」，不误触发选品

### 本轮发现并修复的 bug

**1. `adaptOrder` 漏解 `data` 包装层（最严重，会导致重复下单）**
- 现象：`POST /api/orders/confirm-cart` 返回 409「建单返回看不懂」
- 实际：MCP 已建单成功（orderId 已生成、状态待支付），但本地判成失败、orders 表 0 行
- 后果：用户以为没下成再点一次 → 两份订单要付两次钱
- 修复：`server/src/services/mcp-adapter.ts` 解 `data`，并兼容
  - `orderId` 也可能在 `data.orderDetail.orderId`
  - 支付链接字段是 **`payH5Url`**（不是 payUrl）
  - 状态优先取 `orderDetail.orderStatus`（「待支付」），不是顶层数字码 `"10"`
- 新增 `tests/mcp-adapter.test.ts` 7 条，用真实响应结构锁死

**2. 行操作接口漏传 fulfillment 会改错车**
- 现象：`PATCH /api/cart/items/:id` 不传 fulfillment → 404；更糟会改到另一份车同名行
- 根因：`fof()` 默认填「自取」，拿外送的行 id 去自取车找
- 修复：`updateItem` / `removeItem` 的 `fulfillment` 改成可选，省略时按行 id 反查属于哪份车（`findFulfillmentOfItem`）
- `clearCart` 同样处理：省略时清空**全部**，不默认只清自取

**3. 换商品走 resolveProduct 只认编码，不认名字**
- 现象：「把汉堡换成麦乐鸡」→ 回「菜单里搜不到」，但菜单里明明有麦乐鸡
- 根因：swap 分支只调 `resolveProduct`（比 productId），漏了 `searchProducts` 模糊搜
- 修复：抽出 `pickProduct()` 统一「先按编码、再按名字」，swap / add 共用

**4. `stripVerbs` 残留动词和语气词**
- 现象：「把薯条删了」→ hook 回「车里没有『把薯条删了』」
- 根因：只剥「删掉」没剥「删了」，也没去句首「把」
- 修复：补全动词表、去 `^[把将]`、剥句尾语气词 `[了吧呢啊呀哈]+$`

**5. 加购后购物车没有门店编码 → 外送不算配送费**
- 现象：外送车 total 只等于商品价，`deliveryFee` 缺失
- 根因：`fetchProductsForFulfillment` 内部算出 storeCode/beCode 只用去查菜单，没回传；
  加购时 `resolved.storeCode` 为空，写不进车，`applyDeliveryFee` 缺参数直接 return
- 修复：抽 `resolveStoreForFulfillment()` 供「查菜单」和「写回车」共用；`resolveProduct` 回传门店

### 测试
- 后端 **222/222 通过**（原 206 → 新增 16）
  - `mcp-adapter.test.ts` 7 条（新建）
  - `cart-db.test.ts` +6 条（按行 id 反查 4、清空 2、门店信息 2）
  - `cart-intent.test.ts` +3 条（严格相等断言，原本只 includes 导致脏数据也能过）
- 前端 `vue-tsc` 0 error，`npm run build` 成功

---

## 补：订单门店名 + 建单失败话术

用户反馈订单返回的 `store` 是空字符串，要求补上。补的过程中又挖出两个 bug。

### 6. 订单上的门店名一直是空串

三层根因，全部修掉：

| 层 | 问题 | 修复 |
|---|---|---|
| MCP 响应 | `adaptOrder` 没提取 `orderDetail.storeName` | 加 `storeName` 字段，顶层/detail 都认 |
| 到店路径 | `resolveStoreCode` 拿到 storeCode 就 `return { name: storeName }`，name 为空不补 | 加 `lookupStoreName()` 按编码反查；查不到返回空串，**绝不编名字** |
| 购物车 | 车里只存 storeCode，从没存过名字 | `resolveStoreForFulfillment` 回传 name，`addItem` 写入 `store` |

落库改为三级兜底：`order.storeName`（最权威）→ `resolvedStoreName` → `reply.meta.store`。

外送分支补上 `resolveDeliveryStore(..., reply.meta.store)` 的 preferredName 参数。

历史数据用 `scripts/backfill-order-store.ts` 回填（dry-run 默认安全）：
- 到店走 `query-nearby-stores`
- 外送走 `delivery-query-stores`（**必须按 addressId**，两套门店列表不同）
- 实测 4 条订单补上 1 条，其余 2 条本身已有、1 条无 store_code 放弃

### 7. MCP 明确拒绝时却回「看不懂」

测试下单数超限，MCP 返回：
```
{"success":false,"code":600039,"message":"今日下单数已经上限"}
```
这是**完全可读**的响应，只是没有 orderId。原代码一律回「建单返回看不懂，先去 App 里看看」——
用户不知道被限购了，会一直重试，重试到明天也一样失败。

修复：
- 新增 `mcpFailureReason()` 从失败响应读 message
- 新增 `OrderRejectedError`（`ORDER_REJECTED` / 422 / **retriable:false**）
- 区分三种情况：MCP 说了原因 → 透传原话；真认不出 → 「看不懂」；成功 → 正常

顺带修了个更危险的：`adaptOrder` 的 orderId 候选里有 `'id'`，
失败响应若带 `id` 会被解析成假订单，用户拿无效 orderId 去付款。
现在 `success:false` 硬性返回 null。

前端 `types.ts` / `api.ts` 同步注册 `ORDER_REJECTED`；下单失败的 `catch` 走 `messageOf`
天然透传原话，不需要额外分支。

实测：`{"error":"ORDER_REJECTED","message":"下单没成功：今日下单数已经上限","retriable":false}`

### 最终测试
- 后端 **236/236 通过**
  - `mcp-adapter.test.ts` 10 条（+3：orderDetail.storeName、success:false 判负、顶层 storeName）
  - `order-reason.test.ts` 7 条（新建）
  - `cart-db.test.ts` 26 条（+2：storeName 写入、已有 store 不被覆盖）
- 前端 `vue-tsc` 0 error，构建成功

### 注意
- 测试账号（`f0197b4cbf0782b2`）今日下单数已达上限（`600039`），
  成功下单路径当天无法再实测，靠单测覆盖
- 订单成功路径此前已实测通过：到店 ¥13、外送 ¥21.3，门店名均正确

### 遗留
- 布局/视觉由用户自己看，未做截图评审
- `774405` 那条历史订单无 store_code，无从反查，保留空值
- 播种脚本 `scripts/mint-session.ts`：给已有用户直接签 JWT，绕开 MCP token 失效做本地验证


## 修复：聊天区消失、只剩购物车（11:16-11:27）

### 现象
用户截图：对话点餐页只有右侧「购物车」一张卡，左侧聊天区完全不见。

### 根因（两个问题叠加）
1. **全局类冲突（主因）**：`App.vue:163` 给路由根元素追加 `:class="isChat ? 'page-chat' : 'page'"`，
   而 `ChatView.vue` 的根节点本身就是 `.chat-layout`（`display:flex`，意图是左右两栏）。
   `styles/layout.css:306` 的 `.page-chat` 声明了 `flex-direction: column`，
   把左右布局强制改成上下堆叠 → `.chat-wrap` 高度塌成 **2px**、`.chat-scroll` 高度 **0**，
   画面上就只剩购物车。
2. **模板结构错位**：`.composer`（输入区）被放在 `.chat-wrap` 外面、成了 `.chat-layout` 的第三个子节点，
   语义上它应该在左栏内部的底部；且旧代码多了一个未闭合 `</div>`。

### 修复
- `ChatView.vue` 模板：把 `<!-- 输入区 -->` 整块移入 `.chat-wrap` 内部（`chat-scroll` 之后），
  补回 `chat-scroll` 的闭合标签，修正缩进与结尾闭合（918 关 `chat-wrap`、938 关 `chat-layout`）。
- `ChatView.vue` 样式：
  - `.chat-layout` 显式 `flex-direction: row` + `align-items: stretch` + `overflow: hidden`，
    并加注释说明为什么必须钉死方向（防再被 `.page-chat` 覆盖）。
  - `.chat-wrap` 改 `flex: 1 1 0` + `min-height: 0`，仍为纵向 flex（滚动区吃满、输入区钉底）。
  - `.cart-slot` 改 `flex: 0 0 320px`，补 `display: flex; flex-direction: column`。

### 实测（CDP 量 DOM + 截图）
- 宽屏 1418px：`chat-wrap` 844×658、`chat-scroll` 842×556、`composer` 842×100 贴底、`cart-slot` 320 宽 —— 全部正常
- 窄屏 958px：`cart-slot` 变 `position: fixed` 抽屉，`transform: translateX(346.8px)` 藏在屏外，聊天区占满 746px
- 真实对话「一个人五十块不辣」：气泡、套餐摘要、确认下单按钮、右侧购物车三件 ¥64.0 同时显示正常
- `vue-tsc --noEmit` 0 error，`vite build` 成功

### 经验（重要）
`App.vue` 用 `:class` 往路由根元素注入全局 `page-chat` / `page` 类，
**任何页面自己的根元素样式都会和这个全局类打架**。
以后新增页面若根节点自己有布局（flex/grid），必须在自己的 scoped 样式里显式声明方向与对齐，
不能只靠 `display:flex` 吃默认值。

### 新增脚本
- `server/scripts/shot-narrow.mjs`：窄屏布局诊断（可传宽高），验证 <=1100px 时购物车抽屉化

## 选品细化：默认 1 人 + 模型事后复核（11:59-12:25）

### 需求
1. 没说人数的情况**默认为一个人**
2. 点完之后再用模型做一次校验，看配得合不合理
3. 判断之后如果**非常不合理要改单**

### 一、人数：默认 1 人 + 修数量词误判
`intent.service.ts`
- 新增 `FOOD_AFTER_GE` 正则：量词「个」后面紧跟食物名（汉堡/薯条/可乐/新地/套餐…）时
  **不当人数**，continue 继续找。
  修掉的老 bug：「两个汉堡一杯可乐」被 extractPeople 判成 2 人 → 按 2 人份配菜，
  一个人吃收到双份主食。实测「两份薯条」「两杯可乐」「我要一个套餐」均正确返回 undefined。
- 解析层**不伪造**人数（仍返回 undefined），由编排器 `intent.explicit.people ?? 1` 兜成 1 人。
  另留 `peopleExplicit` 标志，让复核能区分「用户说 1 人」和「我们默认 1 人」。

### 二、复核服务（新建 `services/menu-review.service.ts`）
定位：选品仍由 selector 确定性产出，复核只在**出单之后**体检一次。

- `reviewMenu()` → `ReviewResult { ok, issues, checked, severity: none|minor|major, verdict?, avoidNames? }`
- **永不抛错**：任何异常都退化成「没发现问题」，绝不让用户拿不到菜单
- 模型**无选品权**：只输出 `remove`（要删的序号数组）+ `avoid`（要换的商品名）+ severity
- 输出格式踩过的坑：第一版让模型输出嵌套对象 `{kind, fix, index, qty}`，
  deepseek 实际把 `issues` 写成**字符串数组**、`avoid` 写成「避免同时点多个同类汉堡」这种建议句
  → 全部对不上，复核等于白跑。改成扁平 `remove: [1,3]` 后才稳定。
- `maxTokens` 必须给 1200：给 500 时 reasoning 型模型把额度吃满、JSON 被截断，
  解析失败后按「没问题」处理 → 静默哑火（实测连续两次 tokens=805+500 / 818+500）
- `avoid` 必须能对上菜单里的真实商品名，对不上就丢掉（否则重配时匹配不到，等于没改）

### 三、两档处理：minor 做减法 / major 改单
`decideAction(review)` 抽成纯函数（真实链路上规则选品很克制，很难自然触发 major，
只能靠单测锁死这条路径）：
- `none` → keep
- `minor` → **prune**：本地 `applyReviewFixes` 删项，只删不加，价格只降不升
- `major` + 有 avoidNames → **rebuild**：把名字带回 `selectProducts({avoidNames})` 整单重配
- `major` 但没给商品名 → 退成 prune（否则白烧一次 MCP 额度还可能配更乱）
- 重配结果和原菜单**完全一样**时（全店只有一款套餐）→ 保留原菜单改做减法

`selector.service.ts`：`SelectInput` 加 `avoidNames?: string[]`，命中时 score 压到负分
（`Math.min(score,0)-1`），只降权不删池 —— 兜底逻辑仍能找到它们，不会凑不出单。

`applyReviewFixes` 三条安全线：只做减法不通融 / 会把菜单清空就整体放弃 / 下标越界不误删。

### 四、编排器接入（`orchestrator.ts`，插在选品后、算价前）
新 stage `review`（`StageName` 前后端同步 + `stage-texts.ts` 三条文案）。
位置很关键：重配后还要走后续的外送算价与预算二次校验，放算价之后就会拿旧价。

### 五、实测
- 单测 **254/254**（+18：人数 3 / 决策 6 / 减法 6 / 重配 3）
- 真实模型三次判定全对：
  - 「1人4主食2甜品」→ major「一人四主食两甜品，严重过量」+ avoid 两个商品名
  - 「套餐+多一杯可乐」→ minor「套餐已带可乐，又单点一杯重复」
  - 「正常人一餐」→ none「一人一份套餐，合理」
- 真实链路：¥64（吉士汉堡包套餐+新地+麦乐鸡开心乐园餐）→ 复核删乐园餐 → **¥39**
  「一个人五十块不辣」和「今天有点烦躁」（不说人数）都走通
- `tsc` 0 error，`vue-tsc` 0 error，前端构建成功

### 经验
让 LLM 做判断题时，**输出格式越扁平越稳**。嵌套对象 + 枚举白名单看起来很严谨，
实际模型经常降级成字符串数组；序号数组（[1,3]）这种"笨"格式反而 100% 稳定。
另外 reasoning 型模型要留意 `reasoning_content` 会挤占 max_tokens。

---

## 架构重构：LLM 主导意图解析 + 旁路判断（13:00-14:20）

### 用户指令（这是推翻旧架构的核心要求）

> 「直接用 llm 做意图解析。如果是模糊意图，比如说是很烦，今天心情不错，或者说类似就是给我点个午餐
> 没有明确的。旁路根据用户知识（包括当下时间判断），判断结论导入主loop。主loop
> 2.导入mcp真实数据。3.选品。4.另外调用llm根据用户输入和购物车结论做判断。5.算价.
> 6.文案生成。7.落盘+同步购物车。如果有明确意图 比如我要吃辣，3个人50块这种。
> 就不需要旁路进行用户知识背景分析，直接第二步」

### 新架构落地

**新建 `server/src/services/llm-intent.service.ts`（约 520 行）**
- `parseIntentWithLlm(message, {now})` —— LLM 成为意图解析唯一入口，**永不抛错**（失败退规则）
- `analyzeContext(input)` —— 旁路判断，输入记忆快照 + 时间事实，输出方向标签/推定人数/avoid
- `applyContextToIntent(intent, ctx)` —— 旁路结论并入意图，**只填空不覆盖**
- `mergeIntent(rule, raw, message)` —— 模型结果 + 规则结果合并

**clarity 判定权完全交给模型**（这是修掉「帮我点个午餐被反问」的根本）
- `IntentClarity = 'clear' | 'vague'`，加入 `ParsedIntent`
- 口径：**光靠这句原话能不能直接在菜单上挑出东西**
- 强制兜底：有 taboo/people/budget 时无论模型说什么都拉回 clear（防模型手滑把忌口弄丢）

**契约扩展**（`contract.ts`）
- `ParsedIntent` 加 `clarity` / `orderIntent` / `reasoning` / `softBudget` / `contextRead` / `contextAvoid`
- `StageName` 加 `'context'`（前后端同步 + stage-texts 三条文案）

**忌口三层防护**
1. 模型 + 规则取**并集**（漏一个是安全事故）
2. 模型说的忌口必须在原文里能对上否定词，否则丢弃（用户说"想吃辣"模型写 taboo:["辣"] 会清空整个辣味菜单）
3. 口味与忌口重叠时口味让位

**旁路预算不能进 explicit.budget（踩过的坑）**
记忆 `budgetRange: [46.28, 87.5]` → 旁路填 87.5 → 会①冒出预算进度条 ②触发超预算重选 ③落库当事实
且模型每次推的数不同（实测 87 / 88 / 87.5），同一句话每次菜单都变。改走 `softBudget`，纯参考。

**口味标签规范化（`canonicalizeTaste`）**
模型爱输出「解压」「省事」「暖胃」这类语义标签，`matchTasteTag` 不认 → **静默失效**（选品一个字没听进去）。
映射：解压→辣+大份 / 省事→大份 / 暖胃→热 / 提神→咖啡，认不出的直接丢。

**判断环节纳入购物车结论**（`menu-review.service.ts`）
- `ReviewInput` 加 `cart` / `cartTotal` / `cartRelation: 'replace'|'merge'` / `contextRead` / `avoidFromContext`
- 关键认知：主 loop 是**整份替换**购物车，所以车里的价值不是"去重"，而是**记录用户编辑痕迹**
- `detectUserRemovals()`：读 chats 表上一轮 reply_json 对比当前车，少掉的认定为用户主动删除 → 转成选品降权
- maxTokens 提到 **2000**（1200 仍被 reasoning 吃满：实测 1392+1200 截断）

**忌口矛盾修复（真实链路发现的）**
记忆记「忌辣」+ 当轮说「我要吃辣的」→ 一边给辣单品一边文案说"你忌辣我得拦一下"。
`dropOverriddenTaboo()`：当轮原话 > 历史记忆，但**只让口味型忌口让位**，过敏源永远不让。

### 验证
- 单测 **297/297**（+38：`tests/llm-intent.test.ts` 新建）
- 解析层 dry-run **8/8 全部符合预期**
- 真实链路两条路径都通：模糊「今天很烦」→ 跑旁路、不反问、出 ¥64 菜单；
  明确「我要吃辣的」→ 跳过旁路，判断环节判 minor 删一项 ¥64→¥39.40

### 新增脚本
- `server/scripts/verify-loop.ts`：新架构验证（`--dry` 只跑解析层，不烧 MCP 额度）
- `server/scripts/shot-html.mjs`：静态 HTML 整页截图（**必须连 /json/list 的 page target，不是 /json/version**）
- `server/scripts/shot-el.mjs`：按 CSS 选择器截局部 2x 高清图

---

## 重做《点餐引擎运行逻辑》HTML → 树状版

### 用户反馈
> 「我的意思是树状的显得厉害，而不是一个线直上直下，看的也不清晰」

旧版是一条竖线 `.pipe-step` 往下堆 15 个 section，视觉上就是根棍子。改成**树状分叉**。

### 新版结构（`麦门知己-点餐引擎运行逻辑.html`，50KB）
- 3 张手写 SVG 树：全局主树（1000×1340）、出单判断三档树、购物车结论双分支树
- 节点按角色着色：紫=模型 / 黄=规则 / 蓝=真实数据 / 绿=落盘 / 红=决策点
- 主干一条竖线，**两处真正分叉**：① clarity 左右分（旁路 / 直下）　③ 三档分（keep/prune/major）
- 红色虚线 = 重配回环，从 major 右边缘绕上去回选品，**不与其他连线交叉**
- 12 个 section：铁律 → 全局树 → 四个分叉逐个拆 → 主循环 → 实证 → 降级表 → 为什么这样分工

### SVG 排版的坑
- `.tree-svg` 不能写 `min-width:900px`，否则容器 766px 时横向溢出被裁 → 去掉，靠 viewBox 自适应
- `shot-el.mjs` 截元素必须先让视口装得下整块（`box.x + box.w + 60`），否则 clip 以可视区为界裁掉左边
- 回环线走出节点框：路由高度要避开三档框的 860-920 区间，从 890 先横移到 944 再上行
- 竖排标签（`writing-mode:vertical-rl`）在窄缝里挤成一坨 → 改横排两行短词

### 验证
13 个锚点全部有效，无重复 id；三张树图逐张截图验收通过

---

## 修 bug：「三个人的午餐」没优先点三人餐（14:20-14:50）

### 现象
用户实测「帮我点个三个人的午餐」（外送，厦门塔埔路店），出单：
`吉士汉堡套餐 ×3 ¥96 + 草莓新地 ×2 ¥27 = ¥132（+运费6+打包3）`
而同一张菜单里明明有 **¥86 的「畅享吃鸡三人餐」**。

复现时还撞出一个更严重的变体：`吉士汉堡套餐 ×3 + 草莓新地 ×2 + 畅享吃鸡三人餐 ×1 = ¥221`，
即 **3 个人拿到 6 人份**。

### 根因（两个独立 bug，都在 `selector.service.ts`）

**1. `servesOf()` 把「三人」并进 `return 4`**
```ts
if (/多人|全家|四人|4\s*人|三人|3\s*人/.test(n)) return 4;  // 旧
```
后果：
- 打分环节 `serves(4) > people(3)` 只给「够 4 人吃」+1；
  而单人套餐 `serves(1)` 命中「应季·汉堡」拿 +3 → 三人餐永远排不过它
- 份数 `ceil(3/4)=1`，记账按 4 人份 → 账面上"够吃"，实际 3 人只有 1 份
- 于是又补 3 份单人套餐

**2. `isCombo()` 白名单里没有裸「N 人餐」**
「畅享吃鸡三人餐」「合家欢聚鸡牛三人餐」「吃鸡盛宴四人餐」名字不带「套餐」二字，
全部被判成**单品**。后果比"少个候选"严重：
- 第一轮「整餐优先」收不到
- 第二轮「补主食」`roleOf` 也认不出（名字里没堡/饭/卷）
- 结果从**第三轮「补配角」**混进来，被当成一份小食 → 6 人份

### 修复（4 处）

| 位置 | 改动 |
|---|---|
| `servesOf` | 拆开：双人→2、**三人→3**、四人/多人/全家→4 |
| `isCombo` | 补 `/[一二三四五六两\d]\s*人餐/` 兜住裸「N 人餐」 |
| 第一轮选整餐 | 从「按分数排」改成**按人数匹配度分层**（见下） |
| 第三轮补配角 | 小食上限 3 人以上去掉 +1 余量；配角单价 ≤ 主餐 60% |
| reason 文案 | 「双人餐，一份够 N 人」写死 → `「${serves} 人份，一份够 ${serves} 人」` |

**分层排序（关键设计）** —— 分数是加权求和，单人套餐和多人餐在分数上不可比：
```
0 档  serves === people       刚好一份够所有人（最优）
1 档  serves > people         一份有多
2 档  serves >= 2 && < people 多人餐，按 qtyOf 叠份
3 档  serves === 1            单人餐（只在凑不出多人餐时用）
同档：超额人数少的 → 覆盖人数多的 → 分数高的 → 便宜的
```
做成**结构优先级**而不是继续加权重 —— "一份 3 人餐"和"3 份 1 人餐"在总价、
剩菜、饮品份数上根本不同，权重调不出来。

### 第二道防线：`structuralCheck()`（确定性，不调 LLM）
新加在 `menu-review.service.ts`，`reviewMenu()` 开头先跑，命中就**跳过模型**。

理由：复核 prompt 写"多人餐按人数计份"只是**请求模型理解**，不是**保证**；
模型超时/乱码/判成"合理"时复核退化成"没发现问题"，菜单原样发给用户。
人数档位是**算术问题**，不该交给概率模型。

安全边界：只在多人餐已覆盖全部人数时才判重复；只删单人**套餐**不碰单品汉堡；
删完必须仍够吃否则整体放弃；只做减法。

### 实测结果（真实外送链路，厦门塔埔路店）

| 人数 | 修复前 | 修复后 |
|---|---|---|
| 3 人 | 吉士套餐×3+新地×2 = **¥132** | 畅享吃鸡三人餐×1+新地×2 = **¥122** |
| 2 人 | — | 快乐吃鸡双人餐×1+新地+麦乐鸡 = **¥93.4** |
| 1 人 | — | 吉士汉堡套餐+新地+麦乐鸡 = ¥60.5 |
| 4 人 | — | 吃鸡盛宴四人餐×1+新地×2 = ¥134 |

### 测试
- 后端 **311/311**（原 310 → 新增 15 条）
  - `selector.test.ts` +8：三人餐识别/serves=3、3 人优先三人餐、不吃单人餐、
    主食 ≤4 人份、总价不高于 ¥132、2/4 人命中对应档、5 人文案不自相矛盾、配角单价
  - `menu-review.test.ts` +7：structuralCheck 六种边界 + applyReviewFixes 不删空
- `tsc --noEmit` 0 error

### 踩坑记录
- **修完根因不等于结果合理**：第一版修完结构对了，但总价从 ¥132 涨到 ¥161.9 ——
  三人餐自带 3 份小食已占满额度，可「每人 +1 余量」还放行了一份 ¥39.9 炸鸡拼盘。
  **改完必须看总价，不能只看结构**
- 配角单价用「≤ 主餐单价」这种绝对比较**没用**：¥39.9 < ¥55.9 照样过。
  必须用比例（60%）
- 服务改了 `dist` 不重启就等于没改 —— 验证前先 `npm run build` 再重启
- curl 访问 localhost 要加 `--noproxy '*'`，否则被环境变量里的代理劫持成 502
- 后台起的 node 进程会随 shell 退出，得用 run_in_background

---

## 重写《点餐Agent-Loop》HTML → CSS 框图版（15:00-14:00）

### 用户两轮反馈
1. 「loop全景用之前的那种树状图好看一些」
2. 「**就是不要这种字符风格，做成框图类似mermaid渲染后的样子**」—— 明确否决 `│ ├─ └─` 字符画

### 做法
纯 HTML + 内联 CSS 画框图，**不引 mermaid.js**（保持单文件零依赖），连线全用伪元素：

| 组件 | 实现 |
|---|---|
| `.mm-node` | 节点卡片，白底 + 圆角 + 浅阴影 |
| `.mm-node.stage-node` | 黄色 4px 左边框 = 发 SSE stage |
| `.mm-node.io` | 深色终端节点（`runChat()`、用户输入） |
| `.mm-node.exit` | 绿色成功态（支付卡轮询） |
| `.mm-arrow` | 竖线 + CSS 三角箭头 |
| `.mm-fork.n2/.n3` | 上方短竖线 + 下方横线（分叉） |
| `.mm-split.n2/.n3` | `display:grid` 分列，每列顶部补短竖线 |
| `.mm-join.n2/.n3` | 汇合横线 + 下行短竖线 |
| `.mm-chips > span` | 节点内细节标签，`err/ok/hi` 三色 |

第 1 节共 **22 个节点**，含 1 处三分叉（校验/限流/开流）、1 处二分叉（confirm-cart / confirm chatId）。

### 踩到的三个真 bug（都是渲染后截图才发现的）

**1. 类名冲突把整张节点卡片压成小徽章（最严重）**
`.mm-node.stg`（节点变体，想加黄色左边框）和表格行内徽章 `.stg`
（`display:inline-block; background:var(--ink); padding:1px 6px`）**同名**。
结果每个 stage 节点变成一条深色窄条：标题看不见、chips 溢出到卡片外。
修复：节点变体改名 **`.stage-node`**，与徽章类彻底分开。
> 教训：全局工具类命名要带前缀，`mm-*` 命名空间里出现裸 `.stg` 一定出事。

**2. 分叉横线端点没对齐（差约 10px）**
横线用 `left:16.666%; right:16.666%` 算列中心，但没把 `grid` 的 `gap:14px` 算进去。
修复改为按 gap 精确计算：
```css
.mm-fork::after{left:calc((100% - 14px)/4);      right:calc((100% - 14px)/4);}      /* n2 */
.mm-fork.n3::after{left:calc((100% - 28px)/6);   right:calc((100% - 28px)/6);}      /* n3 */
.mm-join::before / .mm-join.n3::before 同理
```
验证：三列宽度各 `w`，gap 14，总宽 `3w+28`；第一列中心 `w/2`，
而 `(100%-28px)/6 = (3w+28-28)/6 = w/2` —— 精确落位。

**3. 窄屏整页横向溢出（顺手修，用户说不纠结移动端，但根因是布局 bug）**
`@media(max-width:900px)` 里 `.wrap{flex-direction:column}` 保留了 `align-items:flex-start`，
纵向 flex 下子项收缩到内容宽度；表格 `th{white-space:nowrap}` 把 `main` 撑到 856px →
整页 880px 宽、hero 文字被裁。
修复：`align-items:stretch` + `main{width:100%;min-width:0}`，窄屏放开 `th` 换行。

### 校验（全部通过）
- Python `html.parser` 栈式校验：**错误 0 / 未闭合 0**
- 18 个 `id="sN"` 与 18 个 `href="#sN"` 完全一致
- 22 个 `.mm-node`、8 个 fork、7 个 join 到位
- 字符画 `│ ├─ └─` 与 `class="flow"` **已彻底清除**
- 无头 Chrome 分段截图逐段人工验收（节点卡片、三分叉、二分叉、汇合、后段表格）
- 移动端 `docScrollWidth = 415`（等于视口，无横向溢出；`PRE` 溢出是代码块自身的横向滚动）

### 文件
`麦门知己-点餐Agent-Loop.html`，**1403 行 / 106KB**，18 节。

### 有效工具
用 iframe + `location.hash` 偏移量做「分段截图」，绕过无头 Chrome 整页截图高度上限：
```html
<iframe src="目标.html" style="position:absolute;width:1150px;height:9000px">
<script>document.getElementById('f').style.top = -parseInt(location.hash.slice(1))+'px'</script>
```
配 `--window-size=1150,1000` 即可截任意高度区间，比 PIL 裁剪省事。


## 报名麦当劳大赛 → 用户取消，转为仓库合规清理

用户原计划报名麦当劳程序员创意开发大赛，后明确取消（该赛事要求 Skill 形态，本项目是完整 Web 应用）。
**未提交任何报名 Issue**，仅完成仓库侧整理。

### 发现并修复的严重问题：凭证已泄露到公开仓库

排查报名材料时发现仓库无 `.gitignore`，9883 个文件入库，其中：
- `server/.env`（含真实 LLM_API_KEY、TOKEN_ENC_KEY、JWT_SECRET）
- `server/data/mcd.db`（含 12 个用户的 AES 加密 MCP Token）
- 9525 个 node_modules 文件、开发探针脚本（`.t*.mjs` 等）、curl 误生成的 cookie 文件 `{}`

密钥与密文同时公开 = 加密失效。已执行：
1. 新建 `.gitignore`（环境变量、data、dist、探针脚本、构建产物）
2. `git rm --cached` 移除全部敏感项
3. 重建 git 历史（orphan 分支 → 单提交 → `git branch -M` → force push）
4. 验证远程 `.env` / `data` / `node_modules` 均返回 404

### 关键教训（已写入 server/.env.example）

**旧 blob 仍可通过 SHA 访问**（`repos/.../git/blobs/c674bc70...` 仍返回 1683 字节）。
GitHub 不立即回收无引用对象 → **必须轮换密钥，删文件不够**。
处置顺序：吊销 LLM key → 换 TOKEN_ENC_KEY/JWT_SECRET → 删 db → 清历史后强推。

### 文档修正（README 与实际代码严重脱节）

| 原描述 | 实际 |
|---|---|
| 无框架、无构建、原生 ES module | Vue 3 + Vite + TypeScript，17 个视图 |
| 91 个单元测试 | 311 个（实测全绿） |
| 13 个 MCP 工具 | 声明 35 个，真实调用 23 个 |
| `python -m http.server` 跑前端 | 不可行，必须 `npm run dev` |
| `web/scripts/e2e.mjs` | 已不存在，实际是 `web/e2e-*.cjs` |

另移除参赛专属文件 `CONTEST_DECLARATION.md`、`docs/SUBMISSION.md`；`web/dist` 移出版本控制（源码 3 秒可重建）。
新增 `MCP_INTEGRATION.md`：基于 2026-10-24 真实联调的 MCP 接入文档（工具清单、调用时序、连接池/限流/缓存/错误三分法、6 个实测字段坑）。
````

---

## 四、可核验的部分

评审核验"是否真实用 WorkBuddy 开发"时，可以看这几处：

| 核验点 | 怎么看 |
|---|---|
| 开发日志真实性 | `.workbuddy/memory/` 下两份日志与本文第三部分逐字一致 |
| MCP 真实调用 | `docs/mcp-live-report.md` 是 10-24 真实调用记录，含 35 个工具的实测返回结构 |
| 工具清单可对照 | `server/src/mcp/gateway.ts` 的 `READONLY_CACHE_TTL` / `WRITE_TOOLS` 与 `MCP_INTEGRATION.md` 一致 |
| 代码可跑 | `cd server && npm test` → 311 通过；`npx tsc --noEmit` → 0 error |
| 踩坑可验证 | 日志里每个 bug 都对应代码里的注释和测试用例（如 `mcp-adapter.test.ts`）|

## 五、说明

- 本项目为个人独立开发，使用 WorkBuddy 作为开发工具，非 WorkBuddy 官方产品。
- 日志中出现的商品价格、门店信息均来自公开菜单接口，不含个人消费数据。
- 供演示使用的 MCP Token 为开发者本人账号，不随仓库分发。
