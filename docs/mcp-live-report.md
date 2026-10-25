# 麦当劳 MCP 实测报告（2026-10-24）

> Token 已实测有效，端点 `https://mcp.mcd.cn`（Streamable HTTP）。
> 本报告基于真实调用，回填 `docs/mcp-tools.md` 的「待联调确认清单」。
> 完整 35 个工具的 name/description/inputSchema 见 `docs/mcp-tools-full.json`。

## 0. 核心结论

1. **服务端实际声明 35 个工具**，远多于文档记的 13 个（文档 13 个全部存在，另有 22 个新工具）。
2. **返回格式不是纯 TOON**：大部分工具返回「markdown 字段说明 + 原始 JSON」混合文本；
   只有 `list-nutrition-foods` 是 TOON 紧凑格式（`[160]{productName,energyKj,...}: ...`）。
   `toon.ts` 的"先 JSON.parse 再 TOON"策略需要调整为"先剥 markdown 头再 parse"。
3. **响应外层统一是** `{success, code, message, datetime, traceId, data}`，业务数据在 `data`。

## 1. 实测通过的工具与返回结构

### 账户 / 资产
| 工具 | 实测返回 |
|---|---|
| `now-time-info` | `data.{timestamp, datetime, formatted, date, year, month, day, dayOfWeek, timezone, offset, utc}` |
| `query-my-account` | 积分账户：`availablePoint`（实测 4880）、`accumulativePoint`、`currentMouthExpirePoint`（本月将过期）、`frozenPoint`、`usedPoint` 等。⚠️ 字段名是 `Mouth`（服务端拼写如此，不是 Month） |
| `query-my-coupons` | 卡包券，返回 **markdown 渲染文本**（券名/用券价/有效期/标签/图片URL），非 JSON |
| `available-coupons` | 麦麦省可领券列表（markdown），含券标题、状态、图片 |
| `query-my-prizes` | 抽奖奖品列表（分页 pageNum/pageSize） |
| `query-lottery-info` / `draw-lottery` | 积分抽奖活动信息 / 执行抽奖（写操作） |

### 定位 / 门店
| 工具 | 实测返回 |
|---|---|
| `query-nearby-stores` | **必传 `beType` + `searchType`**（1=收藏餐厅，2=按位置搜索需 city+keyword）。返回 `data[]{storeCode, storeName, address, distance(米), businessStatus, businessStartTime/EndTime, reservation, reservationTimeOptions[]}`。⚠️ 经纬度固定返回 0，不可用；到店自取(beType=1)返回的门店**无 beCode** |
| `delivery-query-addresses` / `delivery-create-address` / `delivery-query-stores` | 外送地址链路，`delivery-query-stores` 按 addressId 查可配送门店 |
| `query-party-store` / `-date` / `-session` | 主题派对门店/日期/场次查询 |

### 菜单 / 选品
| 工具 | 实测返回 |
|---|---|
| `query-meals` | 入参 `storeCode + orderType(1/2) + beType(1/2/5/6)`，到店自取**不传 beCode**。返回 `data.categories[]{name, meals[]{code, tags[]}}` + `data.meals{code→详情}`：`name, image, currentPrice, originalPrice, discountType(null/"早餐卡优惠"/"促销优惠"/"麦金卡优惠"), canWithOrder, withOrder` + `data.frequent`（常点） |
| `query-meal-detail` | 入参加 `code`。返回 `data{code, name, image, supportModify, modification, rounds[]}`；特制项在 `rounds[].choices[]{code, name, isDefault, diffPrice("+ ¥0"/"- ¥4"), supportModify, modification.items[].values[]}`，values 内含 `selectedKey/unselectedKey`（下单时传的键） |
| `list-nutrition-foods` | TOON 格式：`[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}` 160 个餐品 |
| `query-promotions` / `query-meal-assistance` | 企业团餐（beType=6）促销规则 / 辅助 |

### 优惠
| 工具 | 实测返回 |
|---|---|
| `query-store-coupons` | 入参 `storeCode + orderType + beType`。返回 `data[]{title, couponId, couponCode, tradeDateTime, products[]{productCode, productName}, promotionId}`。同一 couponId 可对应多个券码 |
| `auto-bind-coupons` | 自动领取所有可领券（**写操作**，未实测） |

### 交易
| 工具 | 实测返回 |
|---|---|
| `calculate-price` | 金额单位一律是**分**：`data{productOriginalPrice, productPrice, deliveryOriginalPrice, deliveryPrice, packingOriginalPrice, packingPrice, tablewarePrice, originalPrice, discount, price, productList[]{productCode, productName, quantity, originalSubtotal, subtotal}}` |
| `create-order` | 写操作，未实测。入参 schema：`items, storeCode, orderType, beType, beCode, addressId, remark, needTableware, reservationDate, takeWayCode, withOrder` 等 |
| `query-order` | `data{orderId, orderStatus, status, storeName, storeAddress, orderProductList[]{productName, productImage, quantity, price, comboItemList[]{itemName, itemQuantity}}, totalAmount, realTotalAmount…}`。**orderStatus 枚举：1 待支付、2 配餐中-已支付、4 配送中、6 已完成、7 已取消、8 已评价、10 配餐中-餐厅确认** |
| `cancel-order` / `order-list` | 取消（写）/ 历史订单 |

### 积分商城 / 派对
`mall-points-products`、`mall-product-detail`、`mall-create-order`、`mall-order-list`、`mall-order-detail`、`party-order-create`（均为积分商城与主题派对下单链路）。

### 内容
`campaign-calendar`：当月营销活动日历，返回 markdown（活动标题/介绍/图片，按日期分组，标注"今日/往期"）。

## 2. 对待联调确认清单（§4）的回填

| # | 问题 | 实测结论 |
|---|---|---|
| 1 | query-meals 入参 | `storeCode`（非 storeCode/storeCode 之争：就叫 storeCode）+ `orderType` + `beType`，beType 枚举 1/2/5/6 |
| 2 | query-meals 返回字段 | `code`、`name`、`currentPrice`（现价）、`originalPrice`（原价），无券后价 |
| 3 | modification 结构 | `rounds[].choices[].modification.items[].values[]`，含 `selectedKey/unselectedKey` |
| 4 | calculate-price 返回 | `{originalPrice, discount, price, productList}`，**单位分** |
| 5 | create-order 入参 | schema 已拿到（见 docs/mcp-tools-full.json），未实测 |
| 6 | create-order 返回 | 未实测（写操作需确认后测） |
| 7 | query-order status | 见上 `orderStatus` 枚举 |
| 8 | payUrl 形式 | 未实测（需真实建单） |

## 3. 遗留事项

- `query-nearby-stores` 的经纬度恒为 0，定位只能靠 city+keyword 文本搜索。
- `query-my-account` 字段 `currentMouthExpirePoint` 等是服务端拼写错误，解析时按 `Mouth` 匹配。
- `query-my-coupons` / `available-coupons` / `campaign-calendar` 返回的是 markdown 文本而非 JSON，网关需要按"文本型工具"处理。
- 金额单位不统一：`calculate-price` 用分，`query-order`/`query-meals` 用元字符串。
