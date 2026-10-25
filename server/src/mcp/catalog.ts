/**
 * 麦当劳 MCP 工具目录（35 个，实测于 2026-10）
 *
 * 这份文件是「前端能不能把 MCP 展现出来」的地基：
 * 每个工具的 name / 分组 / 中文标题 / 只读性 / 缓存 TTL / 参数 schema 都在这里，
 * 前端据此渲染能力清单、工具台表单和「哪些能力已接入」的进度。
 *
 * 数据来源：docs/mcp-tools-full.json（真实 tools/list 返回）
 * 不要手改工具名 —— 与 gateway.ts 的 WRITE_TOOLS / READONLY_CACHE_TTL 必须一致。
 */

export type ToolGroup = '定位门店' | '菜单选品' | '优惠券' | '点餐交易' | '积分商城' | '活动派对';

export interface ToolArg {
  name: string;
  type: string;
  required: boolean;
  desc?: string;
  enum?: Array<string | number>;
  default?: unknown;
}

export interface ToolMeta {
  name: string;
  /** 展示顺序（1..35） */
  order: number;
  group: ToolGroup;
  /** 中文短标题 */
  title: string;
  /** 一句话用途，给人看的 */
  use: string;
  /** 只读 = 不改账号状态，可安全重放 */
  readonly: boolean;
  /** 网关缓存 TTL（毫秒），0 = 不缓存 */
  ttlMs: number;
  /** 服务端原话（首行摘要） */
  summary: string;
  /** 服务端原话（完整，用于工具台展开） */
  description: string;
  args: ToolArg[];
}

export const TOOL_GROUPS: ToolGroup[] = ['定位门店', '菜单选品', '优惠券', '点餐交易', '积分商城', '活动派对'];

export const TOOL_CATALOG: ToolMeta[] = [
  {
    "name": "now-time-info",
    "order": 1,
    "group": "定位门店",
    "title": "当前时间",
    "use": "服务器时间与可售时段，用来判断早餐/午餐/夜市",
    "readonly": true,
    "ttlMs": 30000,
    "summary": "获取当前时间信息 - 返回当前服务器的完整时间信息，包括：",
    "description": "获取当前时间信息 - 返回当前服务器的完整时间信息，包括：\n- 时间戳（毫秒级）\n- 格式化的日期时间\n- 年月日信息\n- 时区和UTC时间\n在你不知道当前时间，并且用户需要指定日期查询活动日历的时候有用",
    "args": []
  },
  {
    "name": "query-nearby-stores",
    "order": 2,
    "group": "定位门店",
    "title": "附近门店",
    "use": "按城市+关键词查可点餐门店，自取/得来速两种",
    "readonly": true,
    "ttlMs": 300000,
    "summary": "Description: 到店场景下，查询用户可点餐门店，需要用户明确是到店自取还是车道取餐",
    "description": "Description: 到店场景下，查询用户可点餐门店，需要用户明确是到店自取还是车道取餐\n- beType=1(到店自提): 返回的门店无 beCode，后续工具调用不传 beCode\n- beType=5(得来速): 返回的门店有 beCode，后续工具调用必须传 beCode\nWhen：\n- 用户询问\"我想到店\", \"我想驾车去麦当劳\"\n- 看看我附近有哪些麦当劳的门店\nInput:\n- searchType: 必传，searchType=2 按位置进行搜索， searchType=1 搜索收藏餐厅，默认searchType=1\n- city: 城市，searchType=2 时必填\n- keyword: 位置关键词，searchType=2 时必填\n- beType: 必填，1-到店自取, 5-得来速车道取餐(Drive Through)\nOn Error：\n- 用户没有收藏记录，可使用搜索功能进行搜索\nNext：\n- 展示门店的 storeCode 和 beCode（beType=5 时）\n- reservation=true 时完整展示 reservationTimeOptions，today=true 标记\"(今天)\"\n- 引导用户选择门店",
    "args": [
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "beType必传，1：到店自提, 5-得来速车道取餐(Drive Through)",
        "enum": [
          1,
          5
        ]
      },
      {
        "name": "city",
        "type": "string",
        "required": false,
        "desc": "城市名"
      },
      {
        "name": "keyword",
        "type": "string",
        "required": false,
        "desc": "关键词"
      },
      {
        "name": "searchType",
        "type": "integer",
        "required": true,
        "desc": "searchType=2 按位置进行搜索， searchType=1 搜索收藏餐厅，默认searchType=1",
        "enum": [
          1,
          2
        ],
        "default": 1
      }
    ]
  },
  {
    "name": "delivery-query-stores",
    "order": 3,
    "group": "定位门店",
    "title": "外送门店",
    "use": "按地址 ID 查可配送门店",
    "readonly": true,
    "ttlMs": 300000,
    "summary": "Description: 外送场景下，用户选择完地址后，需要根据地址ID，查询用户当前地址可配送的门店",
    "description": "Description: 外送场景下，用户选择完地址后，需要根据地址ID，查询用户当前地址可配送的门店\nWhen:\n- 外送场景下，用户选择完配送地址后\n- 用户问\"这个地址能送到哪些店\"\n注意：到店场景请使用 query-nearby-stores\nInput:\n- addressId: 地址ID，来源delivery-query-address\n- beType: 必填，2: 麦乐送，6：团餐",
    "args": [
      {
        "name": "addressId",
        "type": "string",
        "required": true,
        "desc": "地址ID，来源delivery-query-address"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "beType：2: 麦乐送，6：团餐"
      }
    ]
  },
  {
    "name": "delivery-query-addresses",
    "order": 4,
    "group": "定位门店",
    "title": "外送地址",
    "use": "用户已存的配送地址列表",
    "readonly": true,
    "ttlMs": 300000,
    "summary": "Description: 外送场景下，查询用户配送地址列表",
    "description": "Description: 外送场景下，查询用户配送地址列表\nWhen：\n- 用户想点麦乐送\n- 用户想吃麦当劳，并配送到家\n- 我想点团餐\nNext：\n- 1:引导用户创建新的配送地址\n- 2:当用户选择企业团餐时，需要引导用户提供预算金额和人数，以便于计算人均预算",
    "args": []
  },
  {
    "name": "delivery-create-address",
    "order": 5,
    "group": "定位门店",
    "title": "新建地址",
    "use": "创建一个新的配送地址（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "Description: 创建用户配送地址",
    "description": "Description: 创建用户配送地址\nWhen：\n- 用户想添加新的配送地址\nInput:\n- city: 城市名称，必填，必须从用户输入中获取实际城市名称，如\"南京市\"\n- contactName: 联系人姓名，必填，必须从用户输入中获取实际联系人姓名，如\"李明\"\n- gender: 性别，必须从用户输入中获取实际联系人性别，如\"先生\"、\"女士\"\n- phone: 联系人手机号码，必填，格式为11位纯数字（以1开头），如\"18616646686\"。\n- address: 配送地址，必填，必须从用户输入中获取实际地址，如\"清竹园9号楼\"\n- addressDetail: 配送地址门牌号，必填，必须从用户输入中获取实际门牌号，如\"2单元508\"\nNext：\n- 当用户选择团餐时，需要引导用户提供预算金额和人数，以便于计算人均预算",
    "args": [
      {
        "name": "address",
        "type": "string",
        "required": true,
        "desc": "配送地址"
      },
      {
        "name": "addressDetail",
        "type": "string",
        "required": true,
        "desc": "配送地址门牌号"
      },
      {
        "name": "city",
        "type": "string",
        "required": true,
        "desc": "城市"
      },
      {
        "name": "contactName",
        "type": "string",
        "required": true,
        "desc": "联系人姓名"
      },
      {
        "name": "gender",
        "type": "string",
        "required": false,
        "desc": "性别"
      },
      {
        "name": "phone",
        "type": "string",
        "required": true,
        "desc": "要求为11位纯数字"
      }
    ]
  },
  {
    "name": "query-meals",
    "order": 6,
    "group": "菜单选品",
    "title": "门店菜单",
    "use": "指定门店+时段的完整菜单、分类与常点",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 餐品列表, 支持到店自提(orderType=1)和外送(orderType=2)两种场景",
    "description": "Description: 餐品列表, 支持到店自提(orderType=1)和外送(orderType=2)两种场景\n企业团餐场景下，可按照这个规则给用户进行搭配\n- **20元以下**: 小食\n- **20-30元**：汉堡+小食 或 汉堡+饮料\n- **30-40元**：汉堡+薯条/小食+饮料\n- **40-50元**：汉堡+薯条+小食+饮料\n- **50元以上**：丰富组合，优先不重复小食\nWhen:\n- 当用户要购买某个餐品时，需要查询一下餐品列表\n- 当用户要查看餐品时价格时，需要查询一下餐品列表\n- 用户要搭配任何商品时进行下单，都需要查询餐品列表，获取商品code\nInput:\n- storeCode: 门店编码，必填\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n到店自取(beType=1) → orderType=1，不传 beCode\n得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，从query-nearby-stores或delivery-query-stores返回结果中获取。得来速(beType=5)/外送(orderType=2)/团餐场景必传，到店自取(beType=1)场景不传"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐",
        "enum": [
          1,
          2,
          5,
          6
        ]
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "订单类型，1-到店（含到店自取+得来速车道取餐），2-外送（含麦乐送+企业团餐）",
        "enum": [
          1,
          2
        ]
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式:yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      }
    ]
  },
  {
    "name": "query-meal-detail",
    "order": 7,
    "group": "菜单选品",
    "title": "餐品详情",
    "use": "单品组成、套餐可选与特制项（去冰/加料）",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 餐品详情, 支持到店自提(orderType=1)和外送(orderType=2)两种场景",
    "description": "Description: 餐品详情, 支持到店自提(orderType=1)和外送(orderType=2)两种场景\nWhen:\n- 用户想要了解餐品有哪些组成\n- 用户想要更换套餐的组成或者更换特制商品\nInput:\n- storeCode: 门店编码，必填\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n到店自取(beType=1) → orderType=1，不传 beCode\n得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- reservationDate: 预约时间，仅当用户要预约下单时，该字段必传，格式形如 2020-08-08 09:30\nOutput展示规则（必须遵守）：\n- 若 data.supportModify=true，在商品名称后面标注【可特调】\n- 若 choice.supportModify=true，在该 choice 名称后面标注【可特调】\n- 不要主动展开特调选项列表，仅当用户主动询问时才展示 modification 内容\n- 展示完详情后，总结当前默认选中的搭配（isDefault=1的choices），并引导用户：\"如需查看或修改特调选项，请回复'查看特调'\"",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，从query-nearby-stores或delivery-query-stores返回结果中获取。得来速(beType=5)/外送(orderType=2)/团餐场景必传，到店自取(beType=1)场景不传"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐",
        "enum": [
          1,
          2,
          5,
          6
        ]
      },
      {
        "name": "code",
        "type": "string",
        "required": true,
        "desc": "餐品唯一编码，快餐门店内唯一标识单个餐品的编码"
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "到店自提场景:orderType=1 && beCode 是个无效参数，不要传，传了会报错；外送场景:orderType=2 && beCode 为delivery-query-address中的beCode；得来速(DT)场景：orderType=1 && beCode 为query-nearby-store中的be",
        "enum": [
          1,
          2
        ]
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式:yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      }
    ]
  },
  {
    "name": "list-nutrition-foods",
    "order": 8,
    "group": "菜单选品",
    "title": "营养成分",
    "use": "160 个餐品的热量/蛋白/脂肪/碳水/钠/钙",
    "readonly": true,
    "ttlMs": 86400000,
    "summary": "获取麦当劳常见餐品的营养成分数据，包括能量、蛋白质、脂肪、碳水化合物、钠、钙等信息，当用户咨询麦当劳餐品的热量、营养，帮助用户搭配指定热量套餐时有用",
    "description": "获取麦当劳常见餐品的营养成分数据，包括能量、蛋白质、脂肪、碳水化合物、钠、钙等信息，当用户咨询麦当劳餐品的热量、营养，帮助用户搭配指定热量套餐时有用",
    "args": []
  },
  {
    "name": "query-meal-assistance",
    "order": 9,
    "group": "菜单选品",
    "title": "团餐助餐",
    "use": "企业团餐下单前取助餐服务码",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 仅支持企业团餐场景(beType=6)在calculate-price前需要获取当前门店可用的助餐服务",
    "description": "Description: 仅支持企业团餐场景(beType=6)在calculate-price前需要获取当前门店可用的助餐服务\nWhen：\n- 企业团餐场景(beType=6)下，用户选完商品后、计算价格前\n- 用户问\"有什么助餐服务\"、\"团餐怎么送\"\nPreconditions：\n- 仅企业团餐场景(beType=6)可用\n- 已通过 delivery-query-stores 获取 storeCode 和 beCode\nInput:\n- storeCode: 门店编码，必填\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n到店自取(beType=1) → orderType=1，不传 beCode\n得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm\nNext：\n- 用户选择助餐服务后，将 gmServiceCode 传给 calculate-price",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "BE编码（Business Entity Code）"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": false,
        "desc": "固定传 6（企业团餐），此接口仅团餐场景使用",
        "enum": [
          6
        ]
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": false,
        "desc": "到店自提场景: orderType=1 && beCode 是个无效参数，不要传，传了会报错 外送场景: orderType=2 && beCode 为delivery-query-address中的beCode 得来速(DT)场景：orderType=1 && beCode 为query-nearby-store中的"
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约时间，仅当用户要预约下单时，该字段必传，格式形如 2020-08-08 09:30"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      }
    ]
  },
  {
    "name": "query-promotions",
    "order": 10,
    "group": "菜单选品",
    "title": "团餐促销",
    "use": "团餐场景的满减/满折规则",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 查询当前门店企业团餐场景下可用的促销规则（满减/满折），仅返回当前时间有效且适用在售餐品的规则原始数据",
    "description": "Description: 查询当前门店企业团餐场景下可用的促销规则（满减/满折），仅返回当前时间有效且适用在售餐品的规则原始数据\nWhen：\n- 企业团餐场景(beType=6)下，用户搭配方案前需要了解当前门店有哪些可用的促销活动/满减满折规则时\n- 用户询问\"有什么优惠\"、\"满多少减多少\"、\"打几折\"时\nPreconditions：\n- 仅企业团餐场景(beType=6)可用\n- 已通过 delivery-query-stores 获取 storeCode 和 beCode\nInput:\n- storeCode: 门店编码，必填\n- beCode: 业务编码，团餐场景必传，与 storeCode 配对使用（从 delivery-query-stores 获取）\n- orderType: 团餐场景固定传 2（外送）\n- beType: 企业团餐固定传 6\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm\nOutput:\n- 返回当前门店有效的促销规则列表（原始结构），每条含 promotionId、promotionType、ruleCategory、beTypes、startTime、endTime、gmServiceCode、products、ruleDetail\n- promotionType 含义：31-满额减，33-订单折扣\n- ruleCategory 含义：30-满折/折扣，40-满减\n- products 含义：适用餐品列表，type=1-包含、2-不包含、3-全部，productCode 为餐品编码\n- 时间无效（已过期/未开始）或与在售餐品无交集的规则已被过滤\nNext：\n- 拿到规则后，由大模型自行根据规则解读优惠并计算搭配方案，工具不做最优推荐",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，团餐场景必传（从 delivery-query-stores 获取）"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "业务类型，固定传 6（企业团餐）",
        "enum": [
          6
        ]
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "订单类型，团餐场景固定传 2（外送）",
        "enum": [
          2
        ]
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式:yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      }
    ]
  },
  {
    "name": "query-my-coupons",
    "order": 11,
    "group": "优惠券",
    "title": "我的卡包",
    "use": "用户已拥有的券（markdown 券面）",
    "readonly": true,
    "ttlMs": 60000,
    "summary": "获取用户卡包中的优惠券资产信息，用于“我有什么券 / 券详情查看”等展示与管理场景。 注意：该接口返回的是用户拥有的券，不进行门店、渠道、配送方式等下单规则校验，因此不承诺可用于当",
    "description": "获取用户卡包中的优惠券资产信息，用于“我有什么券 / 券详情查看”等展示与管理场景。 注意：该接口返回的是用户拥有的券，不进行门店、渠道、配送方式等下单规则校验，因此不承诺可用于当前订单。 若业务目标是“当前门店/当前订单可用的券”，请调用 query-store-coupons",
    "args": [
      {
        "name": "page",
        "type": "string",
        "required": false,
        "desc": "页码，默认第1页，最多5页"
      },
      {
        "name": "pageSize",
        "type": "string",
        "required": false,
        "desc": "每页条数，默认200条，最大200条"
      }
    ]
  },
  {
    "name": "available-coupons",
    "order": 12,
    "group": "优惠券",
    "title": "可领券",
    "use": "麦麦省当前可领取的券",
    "readonly": true,
    "ttlMs": 300000,
    "summary": "查询用户当前可领取的麦麦省的优惠券列表。返回券名称、图片、状态和促销标签。当用户询问有什么优惠、可以领什么券时使用此工具。",
    "description": "查询用户当前可领取的麦麦省的优惠券列表。返回券名称、图片、状态和促销标签。当用户询问有什么优惠、可以领什么券时使用此工具。",
    "args": []
  },
  {
    "name": "query-store-coupons",
    "order": 13,
    "group": "优惠券",
    "title": "门店券",
    "use": "当前门店 + 订单类型下可用的券（含券码）",
    "readonly": true,
    "ttlMs": 300000,
    "summary": "Description: 查询【指定门店+订单类型】下可使用的优惠券，支持到店(orderType=1,含到店自取和得来速)和外送(orderType=2,含麦乐送和团餐)",
    "description": "Description: 查询【指定门店+订单类型】下可使用的优惠券，支持到店(orderType=1,含到店自取和得来速)和外送(orderType=2,含麦乐送和团餐)\nWhen：\n- 当用户已获取到门店时，用户询问\"我有什么优惠券可以用\"\n- 当用户已获取到门店时，用户想在某门店下单前查看可用优惠\n- 当用户已获取到门店时，用户选择了商品后想看能用哪些券\n- 当用户已获取到门店时，用户问\"这个门店能用什么券\"\nInput：\n- storeCode: 门店编码，必填，\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n  到店自取(beType=1) → orderType=1，不传 beCode\n  得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n  麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n  团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，从query-nearby-stores或delivery-query-stores返回结果中获取。得来速(beType=5)/外送(orderType=2)/团餐场景必传，到店自取(beType=1)场景不传"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐",
        "enum": [
          1,
          2,
          5,
          6
        ]
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "订单类型, 1-到店（含到店自取+得来速车道取餐），2-外送（含麦乐送+企业团餐）",
        "enum": [
          1,
          2
        ]
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式 yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码必须全部由数字组成"
      }
    ]
  },
  {
    "name": "auto-bind-coupons",
    "order": 14,
    "group": "优惠券",
    "title": "一键领券",
    "use": "自动领取所有可领券（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "自动领取麦麦省所有当前可用的麦当劳优惠券。无需指定具体的优惠券和couponId，系统会自动领取用户可领的所有券。当用户说\"帮我领券\"、\"自动领取优惠券\"、\"一键领券\"时使用此工具",
    "description": "自动领取麦麦省所有当前可用的麦当劳优惠券。无需指定具体的优惠券和couponId，系统会自动领取用户可领的所有券。当用户说\"帮我领券\"、\"自动领取优惠券\"、\"一键领券\"时使用此工具。",
    "args": []
  },
  {
    "name": "calculate-price",
    "order": 15,
    "group": "点餐交易",
    "title": "价格试算",
    "use": "下单前复核真实价格与可用取餐方式（单位：分）",
    "readonly": true,
    "ttlMs": 0,
    "summary": "Description: 计算商品的价格（含优惠），支持到店自提(orderType=1)和外送(orderType=2)两种场景",
    "description": "Description: 计算商品的价格（含优惠），支持到店自提(orderType=1)和外送(orderType=2)两种场景\nWhen：\n- 用户问\"这些商品多少钱\"\n- 用户问\"总价是多少\"\nInput:\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm\n- storeCode: 门店编码\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n  到店自取(beType=1) → orderType=1，不传 beCode\n  得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n  麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n  团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- items: 商品列表（数组）\n  - productCode: 商品编码，必填\n  - quantity: 商品数量，必填，大于等于1\n  - couponId: 优惠券ID，选填（如果用户要使用优惠券）\n  - couponCode: 优惠券编码，选填（如果用户要使用优惠券）\n  - modification: 特制选项（来自 query-meal-detail 返回的 modification 信息）\n    - values[]: 特制选项列表\n      - code: 特调商品code\n      - key: 特制key（⚠️ 重要规则见下方）\n      - quantity: 特制数量\n    ⚠️ key 传参规则：\n    - 用户选中的特调项：key = query-meal-detail 返回的 selectedKey\n    - 用户未选中的特调项：若该项的 unselectedKey 不为空，key = unselectedKey，也必须传入\n    - 即：对于包含 unselectedKey 的特调组，该组内所有特调项都必须传入，选中的用 selectedKey 作为 key，未选中的用 unselectedKey 作为 key\n- gmServiceCode: 企业团餐场景下，助餐服务code\n- withOrder: 随单购商品，随单购商品来自query-meals，用户可以选择随单购，随单购可享受随单购优惠\n- needTableware: 是否需要餐具费\nNext：\n- 计算成功后：返回的价格字段单位为\"分\"，展示时需除以100转为\"元\"\n- 引导用户：\"确认价格后，可以说'创建",
    "args": [
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，从query-nearby-stores或delivery-query-stores返回结果中获取。得来速(beType=5)/外送(orderType=2)/团餐场景必传，到店自取(beType=1)场景不传"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐",
        "enum": [
          1,
          2,
          5,
          6
        ]
      },
      {
        "name": "gmServiceCode",
        "type": "string",
        "required": false,
        "desc": "团餐-助餐服务码"
      },
      {
        "name": "items",
        "type": "array",
        "required": false,
        "desc": "待价格计算的商品列表"
      },
      {
        "name": "needTableware",
        "type": "boolean",
        "required": false,
        "desc": "是否需要餐具，true需要，false不需要"
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "订单类型，1-到店（含到店自取+得来速车道取餐），2-外送（含麦乐送+企业团餐）",
        "enum": [
          1,
          2
        ]
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式:yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      },
      {
        "name": "withOrder",
        "type": "object",
        "required": false,
        "desc": "随单购商品"
      }
    ]
  },
  {
    "name": "create-order",
    "order": 16,
    "group": "点餐交易",
    "title": "创建订单",
    "use": "建单并返回支付链接（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "Description: 创建麦当劳订单，支持到店(orderType=1)和外送(orderType=2)两种场景下单, 必须先确定订单类型，必填 (1：到店，2外送)",
    "description": "Description: 创建麦当劳订单，支持到店(orderType=1)和外送(orderType=2)两种场景下单, 必须先确定订单类型，必填 (1：到店，2外送)\nWhen：\n- 用户说\"我要下单\"\n- 用户说\"创建订单\"\nInput:\n- addressId: 配送地址ID， orderType=2时必填\n- storeCode: 必填\n- orderType 和 beCode 传递规则（根据用户选择的 beType 确定）：\n  到店自取(beType=1) → orderType=1，不传 beCode\n  得来速(beType=5)   → orderType=1，必传 beCode（从 query-nearby-stores 获取）\n  麦乐送(beType=2)   → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n  团餐(beType=6)     → orderType=2，必传 beCode（从 delivery-query-stores 获取）\n- takeWayCode: orderType=1时必传，取值来自 calculate-price 返回的 data.takeWayList[].code\n- reservationDate: 预约场景必传，非预约场景不传。格式: yyyy-MM-dd HH:mm\n- items: 商品列表（数组）\n - productCode: 商品编码，必填\n - quantity: 商品数量，必填\n - couponId: 优惠券ID，选填（如果用户要使用优惠券）\n - couponCode: 优惠券编码，选填（如果用户要使用优惠券）\n - modification: 特制选项（来自 query-meal-detail 返回的 modification 信息）\n    - values[]: 特制选项列表\n      - code: 特调商品code\n      - key: 特制key（⚠️ 重要规则见下方）\n      - quantity: 特制数量\n    ⚠️ key 传参规则：\n    - 用户选中的特调项：key = query-meal-detail 返回的 selectedKey\n    - 用户未选中的特调项：若该项的 unselectedKey 不为空，key = unselectedKey，也必须传入\n    - 即：对于包含 unselectedKey 的特调组，该组内所有特调项都必须传入，选中的用 selectedKey 作为 key，未选中的用 unselectedKey 作为 key\n - withOrder: 随单购商品，随单购商品来自query-meals，用户可以选择随单购，随单购可享受随单购优惠\n - ",
    "args": [
      {
        "name": "addressId",
        "type": "string",
        "required": false,
        "desc": "配送地址id，外送or团餐的地址"
      },
      {
        "name": "beCode",
        "type": "string",
        "required": false,
        "desc": "业务编码，与storeCode 配对使用，从query-nearby-stores或delivery-query-stores返回结果中获取。得来速(beType=5)/外送(orderType=2)/团餐场景必传，到店自取(beType=1)场景不传"
      },
      {
        "name": "beType",
        "type": "integer",
        "required": true,
        "desc": "1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐",
        "enum": [
          1,
          2,
          5,
          6
        ]
      },
      {
        "name": "gmServiceCode",
        "type": "string",
        "required": false,
        "desc": "企业团餐场景(beType=6)下，必传，参数来自query-meal-assistance"
      },
      {
        "name": "items",
        "type": "array",
        "required": false,
        "desc": "待价格计算的商品列表"
      },
      {
        "name": "needTableware",
        "type": "boolean",
        "required": false,
        "desc": "是否需要餐具，true需要，false不需要"
      },
      {
        "name": "orderType",
        "type": "integer",
        "required": true,
        "desc": "订单类型，1-到店（含到店自取+得来速车道取餐），2-外送（含麦乐送+企业团餐）",
        "enum": [
          1,
          2
        ]
      },
      {
        "name": "remark",
        "type": "string",
        "required": false,
        "desc": "订单备注（选填，最多50字），如\"无接触配送\"，仅orderType=2场景下需要引导用户填写"
      },
      {
        "name": "reservationDate",
        "type": "string",
        "required": false,
        "desc": "预约场景必传，非预约场景不传。格式:yyyy-MM-dd HH:mm"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店编码（storeCode）, 不能为空"
      },
      {
        "name": "takeWayCode",
        "type": "string",
        "required": false,
        "desc": "到店/得来速场景(orderType=1)必传，外送/团餐场景(orderType=2)不传。值从 calculate-price 返回的takeWayList[].code 中选取"
      },
      {
        "name": "withOrder",
        "type": "object",
        "required": false,
        "desc": "随单购商品"
      }
    ]
  },
  {
    "name": "query-order",
    "order": 17,
    "group": "点餐交易",
    "title": "订单详情",
    "use": "按订单号查状态与商品明细",
    "readonly": true,
    "ttlMs": 0,
    "summary": "Description: 查询订单详细信息",
    "description": "Description: 查询订单详细信息\nWhen：\n- 用户询问\"查下订单详情\"、\"订单状态\"、\"我的订单\"\n- 用户提供了麦当劳订单编号想查询配送进度\n- 用户说我已支付或者支付失败时，查询一下最新的订单状态",
    "args": [
      {
        "name": "orderId",
        "type": "string",
        "required": true,
        "desc": "No comments found."
      }
    ]
  },
  {
    "name": "cancel-order",
    "order": 18,
    "group": "点餐交易",
    "title": "取消订单",
    "use": "取消未出餐的订单（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "Description: 取消订单，非商城订单",
    "description": "Description: 取消订单，非商城订单\nWhen：\n- 用户说\"取消订单\"、\"我要取消\"\n- 用户说\"帮我取消一下订单\"\nInput:\n- cancelReasonCode: 取消原因code，必填，可选值：1=改主意了, 2=重复下单, 3=点错了/点多了/点少了, 4=地址/电话填错了, 5=送达时间选错了, -1=其它原因\nNext：\n- 提示用户\"订单已取消\"",
    "args": [
      {
        "name": "cancelReasonCode",
        "type": "string",
        "required": true,
        "desc": "取消原因code，默认为1"
      },
      {
        "name": "orderId",
        "type": "string",
        "required": true,
        "desc": "订单号"
      }
    ]
  },
  {
    "name": "order-list",
    "order": 19,
    "group": "点餐交易",
    "title": "历史订单",
    "use": "麦当劳餐品历史订单",
    "readonly": true,
    "ttlMs": 120000,
    "summary": "Description: 查询麦当劳历史订单，非商城订单，商城订单需要使用mall-order-list",
    "description": "Description: 查询麦当劳历史订单，非商城订单，商城订单需要使用mall-order-list\nWhen：\n- 用户询问\"帮我查询一下历史订单\"\n- 用户询问\"我买了什么麦当劳餐品\"",
    "args": []
  },
  {
    "name": "query-survey-coupon",
    "order": 20,
    "group": "点餐交易",
    "title": "满意度券",
    "use": "按订单号查 CSAT 答卷与关联奖券",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 按订单号查询当前 MCP 用户本人订单的 CSAT 满意度答卷，并返回该订单关联奖券的标题、核销时间、核销状态和点餐方式。",
    "description": "Description: 按订单号查询当前 MCP 用户本人订单的 CSAT 满意度答卷，并返回该订单关联奖券的标题、核销时间、核销状态和点餐方式。\nWhen: 用户询问某个订单的满意度答卷结果时使用；用户询问某个订单关联奖券的内容、核销时间、是否已核销、适用于到店还是外送时使用。\nInput: orderId 为用户提供的订单号；Agent 不要自行生成。\nNext: 将返回的满意度描述、奖券标题、核销时间、核销状态和点餐方式告知用户；未返回的原始答卷、会员号、couponId、couponCode 不要猜测。",
    "args": [
      {
        "name": "orderId",
        "type": "string",
        "required": true,
        "desc": "订单号。必填。类型为字符串，仅允许字母、数字、下划线和连字符，最长 64 位，格式示例：1030108270000795607354880945。数据来源为用户明确提供的订单号或上游订单查询工具返回的订单号；Agent 不要自行编造或改写该值。"
      }
    ]
  },
  {
    "name": "query-my-account",
    "order": 21,
    "group": "积分商城",
    "title": "积分账户",
    "use": "可用/累计/本月过期/已用积分",
    "readonly": true,
    "ttlMs": 60000,
    "summary": "查询用户积分账户详情 - 当用户询问\"我有多少积分\"、\"查下我的积分\"、\"积分余额\"、\"查询过期积分\"时使用",
    "description": "查询用户积分账户详情 - 当用户询问\"我有多少积分\"、\"查下我的积分\"、\"积分余额\"、\"查询过期积分\"时使用",
    "args": []
  },
  {
    "name": "query-lottery-info",
    "order": 22,
    "group": "积分商城",
    "title": "抽奖活动",
    "use": "活动规则、消耗、剩余次数与奖品池",
    "readonly": true,
    "ttlMs": 120000,
    "summary": "Description: 查看当前积分抽奖活动信息，包括活动基本信息、抽奖消耗规则、单次所需积分、剩余可抽次数、当前可用积分与公开奖品列表，不执行抽奖。",
    "description": "Description: 查看当前积分抽奖活动信息，包括活动基本信息、抽奖消耗规则、单次所需积分、剩余可抽次数、当前可用积分与公开奖品列表，不执行抽奖。\nWhen：\n- 用户询问\"积分抽奖有什么奖品\"\n- 用户询问\"抽一次要多少积分\"\n- 用户询问\"这个积分抽奖活动什么时候结束\"\nOutput:\n- activityCode/activityName: 活动号/活动名称\n- activityStatusText: 活动状态文案（未开始/进行中/已结束/活动不存在）\n- beginTime/endTime: 活动起止时间\n- drawPoint: 单次所需积分\n- drawTypeText: 抽奖消耗规则（无/消耗积分抽奖/消耗任务完成次数/先消耗次数再消耗积分抽奖）\n- availableTimes: 剩余可抽次数（消耗任务完成次数、先消耗次数再消耗积分时返回）\n- availablePoint: 当前可用积分（消耗积分、先消耗次数再消耗积分时返回）\n- drawDecision: 服务端计算的本次资源决策，包含能否因积分/次数资源参与、本次实际消耗及后续兜底消耗\n- prizes: 奖品列表[{name, imageUrl, typeText}]\nNext：\n- 若用户接下来想抽奖，调用 draw-lottery 前必须展示 drawDecision.nextConsumption 并得到用户明确确认\n- 抽奖资格和本次实际消耗必须以 drawDecision.resourceEligible/drawDecision.nextConsumption 为准；严禁根据 availableTimes 为 0/null 或 drawTypeText 自行推断能否抽奖。混合规则中 availableTimes=0 且 nextConsumption.type=POINTS，表示仍可使用积分抽奖。",
    "args": []
  },
  {
    "name": "draw-lottery",
    "order": 23,
    "group": "积分商城",
    "title": "抽一次奖",
    "use": "按活动规则消耗积分/次数抽奖（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "Description: 使用后台配置的抽奖消耗规则参加一次当前积分抽奖并返回结果，服务端原子完成次数或积分扣减与抽奖。",
    "description": "Description: 使用后台配置的抽奖消耗规则参加一次当前积分抽奖并返回结果，服务端原子完成次数或积分扣减与抽奖。\n重要约束：仅能在向用户展示 query-lottery-info 返回的 drawDecision.nextConsumption 并得到明确确认后调用。\n- 必须以 drawDecision.resourceEligible 判断积分/次数资源是否满足，以 nextConsumption 说明本次实际扣减；不得根据 availableTimes 为 0/null 或 drawTypeText 自行判断。\n- 若 fallbackConsumption 不为 null，需说明“本次优先消耗次数；次数用完后将改为消耗积分”。\n必须使用 query-lottery-info 返回的实时数据展示消耗/剩余，严禁试抽、自动抽或连续抽。\n频次限制：同一用户短时间内重复调用会返回\"操作太频繁，请稍后再试\"，不扣积分。\nWhen：\n- 用户明确表达\"我要抽奖\"并确认本次配置对应的消耗后调用\n前置条件：\n- 已向用户展示 query-lottery-info 查询到的 drawDecision.nextConsumption；resourceEligible 为 false 时不得调用\n- 用户已明确确认执行抽奖（\"试试看\"\"如果可以就抽\"不视为确认）\nOutput:\n- status: {code, message}，code 非 SUCCESS 时 message 为具体失败原因，直接展示给用户，不要自行改写\n- win: 是否中奖\n- prizes: 中奖奖品数组[{name, imageUrl, typeText, validDateInfo}]，未中奖为空数组",
    "args": []
  },
  {
    "name": "query-my-prizes",
    "order": 24,
    "group": "积分商城",
    "title": "我的奖品",
    "use": "抽奖所得奖品及状态、有效期",
    "readonly": true,
    "ttlMs": 120000,
    "summary": "Description: 查询当前登录会员通过积分抽奖获得的本期及历史奖品（可用/已使用/已过期/已领取/已失效）。",
    "description": "Description: 查询当前登录会员通过积分抽奖获得的本期及历史奖品（可用/已使用/已过期/已领取/已失效）。\nWhen：\n- 用户询问\"我抽中了什么奖品\"\n- 用户询问\"我的奖品还有哪些能用\"\n- 用户询问\"查我的抽奖记录\"\nInput:\n- pageNum: 页码（可选，默认1）\n- pageSize: 每页条数（可选，默认10，最大50）\nOutput:\n- prizes: 奖品列表[{id, name, imageUrl, prizeType, recordTime, status, statusText, timeRemindText}]，按中奖时间(recordTime)倒序\n- pageNum/pageSize: 当前页码/每页条数（归一化后的值）\n- hasMore: 是否还有下一页\n- nextCursor: 下一页游标，无更多时为空\n- truncated: 可选，仅在返回被截断时出现（true）",
    "args": [
      {
        "name": "pageNum",
        "type": "string",
        "required": false,
        "desc": "页码，默认第1页"
      },
      {
        "name": "pageSize",
        "type": "string",
        "required": false,
        "desc": "每页条数，默认10条，最大50条"
      }
    ]
  },
  {
    "name": "mall-points-products",
    "order": 25,
    "group": "积分商城",
    "title": "积分商城",
    "use": "可兑换的商品券/实物/派对等",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "查询可兑换餐品券列表 - 当用户询问\"有哪些积分兑换商品\"、\"积分可以兑换什么\"、\"查看积分商城\"时使用",
    "description": "查询可兑换餐品券列表 - 当用户询问\"有哪些积分兑换商品\"、\"积分可以兑换什么\"、\"查看积分商城\"时使用\n支持类目规则筛选：商品券(1>4)、实物商品(2)、周边产品(2>8)、实物礼品卡(2>9)、生日类派对(1>6>20)、主题类派对(1>6>21)、麦麦体验营(1>6>22)、品鉴会(1>6>25)、读书会(1>6>34)、积分兑换活动(1>6>40)",
    "args": [
      {
        "name": "catRuleIds",
        "type": "string",
        "required": false,
        "desc": "类目规则筛选，支持多选（逗号分隔），非必传，不传时默认查询所有类型。 可选值： - 1>4: 商品券（非预付优惠券） - 2: 实物商品 - 2>8: 周边产品 - 2>9: 实物礼品卡 - 1>6>20: 生日类派对 - 1>6>21: 主题类派对 - 1>6>22: 麦麦体验营 - 1>6>25: 品鉴会 - 1>"
      }
    ]
  },
  {
    "name": "mall-product-detail",
    "order": 26,
    "group": "积分商城",
    "title": "商城商品",
    "use": "SPU 详情与全部 SKU",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "查询积分兑换商品详情 - 当用户询问\"这个商品详情是什么\"、\"查看商品详细信息\"、用户点击商品查看详情时使用",
    "description": "查询积分兑换商品详情 - 当用户询问\"这个商品详情是什么\"、\"查看商品详细信息\"、用户点击商品查看详情时使用\n返回商品的所有SKU规格信息，用户需要选择具体SKU后才能下单兑换\n\n前提条件：\n- 已知商品SPU ID，需要从查询可兑换餐品券列表让用户选择一个spu才可以",
    "args": [
      {
        "name": "spuId",
        "type": "integer",
        "required": true,
        "desc": "商品SPU ID，需要从查询可兑换餐品券列表让用户选择一个spu才可以"
      }
    ]
  },
  {
    "name": "mall-create-order",
    "order": 27,
    "group": "积分商城",
    "title": "积分兑换",
    "use": "用积分兑换商品（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "创建积分兑换订单，仅支持shopId=2（从 mall-product-detail 获取） - 当用户询问\"用积分兑换这个商品\"、\"兑换这个券\"、用户确认兑换商品时使用,切记：如",
    "description": "创建积分兑换订单，仅支持shopId=2（从 mall-product-detail 获取） - 当用户询问\"用积分兑换这个商品\"、\"兑换这个券\"、用户确认兑换商品时使用,切记：如果单个商品一个订单下单；如果用户需要兑换多个商品‘必须’分别下单且‘需要排队’，等前面订单结束响应成功后再调用【mall-create-order】下新的订单\n⚠️ 重要识别规则：\n此工具仅适用于以下场景：\n- 商品券兑换（虚拟商品，spuCategory=1）\n- 实物商品兑换（无门店依赖，spuCategory=2）\n\n❌ 不适用场景（请使用 party-order-create）：\n- 生日派对/主题派对/麦麦体验营/品鉴会/读书会等需要选择门店和场次的活动\n- 积分兑换活动（需要先选择城市、门店、日期、场次）\n\n📋 判断依据：\n当商品不包含门店和场次选择需求时，使用此工具\n前提条件：\n- 必须调用【mall-create-order】完成交易，**禁止**直接生成\"下单成功\"等结论性文字\n- 必须调用【mall-create-order】完成交易，**禁止**直接返回已有订单\n- 必须调用【mall-create-order】完成交易，**禁止**直接返回订单\n- 仅支持shopId=2（从 mall-product-detail 获取）\n- 已知商品SKU ID，需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId\n- 用户积分充足\nWhen：\n- 用户询问\"用积分兑换这个商品\"\n- 用户询问\"我要兑换\"\n- 用户询问\"兑换xxx商品\"\n- 用户询问\"兑换这个券\"\n- 用户确认兑换商品\nInput:\n- skuId: 商品SKU ID，需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId\n- spuCategory: 类目，商品类别，\"1\"虚拟商品, \"2\"实体物品，需要从查询可兑换餐品券列表或查询商品详情中获取\n- addressId: 配送地址ID，spuCategory=\"2\"时必填\n  spuCategory=\"2\"  → addressId（从 delivery-create-address 获取）\n- count: 兑换数量，默认为1\nOutput:\n- orderId: 订单ID\n- coupons: 优惠券信息列表\n- couponId: 优惠券ID\n- orderItemId: 订单子项ID\n- couponCodes: 优惠券码列表\n- receiveQuantity: 领取数量\n- ",
    "args": [
      {
        "name": "addressId",
        "type": "string",
        "required": false,
        "desc": "配送地址ID，spuCategory=\"2\"时必填"
      },
      {
        "name": "count",
        "type": "integer",
        "required": false,
        "desc": "兑换数量"
      },
      {
        "name": "skuId",
        "type": "integer",
        "required": true,
        "desc": "商品SKU ID，需要从查询可兑换餐品券列表或查询商品详情中获取"
      },
      {
        "name": "spuCategory",
        "type": "string",
        "required": true,
        "desc": "类目，商品类别，\"1\"虚拟商品, \"2\"实体物品，需要从查询可兑换餐品券列表或查询商品详情中获取"
      }
    ]
  },
  {
    "name": "mall-order-list",
    "order": 28,
    "group": "积分商城",
    "title": "商城订单",
    "use": "麦麦商城订单列表",
    "readonly": true,
    "ttlMs": 120000,
    "summary": "Description: 查询麦麦商城订单列表",
    "description": "Description: 查询麦麦商城订单列表\nWhen：\n- 用户询问\"查看我的麦当劳商城订单列表\"",
    "args": [
      {
        "name": "lastId",
        "type": "number",
        "required": false,
        "desc": "最后一个订单id"
      },
      {
        "name": "size",
        "type": "integer",
        "required": false,
        "desc": "查询数量，默认10，超过10按10条查询",
        "default": 10
      }
    ]
  },
  {
    "name": "mall-order-detail",
    "order": 29,
    "group": "积分商城",
    "title": "商城订单详情",
    "use": "单笔商城订单凭证信息",
    "readonly": true,
    "ttlMs": 120000,
    "summary": "Description: 查询麦麦商城订单详情",
    "description": "Description: 查询麦麦商城订单详情\nWhen：\n- 用户询问\"麦麦商城的订单详情\"\nNext:\n- 引导用户：\"您可以打开麦当劳APP查看凭证等其他信息\"",
    "args": [
      {
        "name": "orderId",
        "type": "string",
        "required": true,
        "desc": "订单号"
      }
    ]
  },
  {
    "name": "campaign-calendar",
    "order": 30,
    "group": "活动派对",
    "title": "活动日历",
    "use": "当月营销活动，按日期分组",
    "readonly": true,
    "ttlMs": 1800000,
    "summary": "查询麦当劳中国当月的营销活动日历，返回进行中、往期和未来日期的活动。适用于查看用户进行中和即将到来的可参与活动，还可查询用户对活动的订阅状态。",
    "description": "查询麦当劳中国当月的营销活动日历，返回进行中、往期和未来日期的活动。适用于查看用户进行中和即将到来的可参与活动，还可查询用户对活动的订阅状态。\nWhen：\n  - 用户问\"最近有什么活动\"、\"这个月有什么优惠活动\"、\"有什么可以参加的\"\n  - 用户想查看品鉴会、主题派对等活动信息",
    "args": [
      {
        "name": "specifiedDate",
        "type": "string",
        "required": false,
        "desc": "可选的查询基准日期（格式：yyyy-MM-dd）；若传入，则以该日为锚点，返回当天及时间线上与其最邻近的前后各一个有活动的日子（共三天）；若不填，默认返回当前月所有活动"
      }
    ]
  },
  {
    "name": "query-party-city",
    "order": 31,
    "group": "活动派对",
    "title": "派对城市",
    "use": "哪些城市可办派对/体验营",
    "readonly": true,
    "ttlMs": 1800000,
    "summary": "Description: 活动派对商品配置场次城市列表, 必须先确定spuId(从 mall-points-products 获取）或查询商品详情（从 mall-product-d",
    "description": "Description: 活动派对商品配置场次城市列表, 必须先确定spuId(从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取)\nWhen：\n- 用户询问\"主题派对在哪些城市\"\n- 用户询问\"我想参加主题派对\"\n- 用户询问\"生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动\"\nPreconditions：\n- 必须先确定spuId（从 mall-points-products 获取或从 mall-product-detail获取）\nInput:\n- spuId: spuId 需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId",
    "args": [
      {
        "name": "spuId",
        "type": "number",
        "required": true,
        "desc": "spuId"
      }
    ]
  },
  {
    "name": "query-party-store",
    "order": 32,
    "group": "活动派对",
    "title": "派对门店",
    "use": "城市下可办活动的门店",
    "readonly": true,
    "ttlMs": 1800000,
    "summary": "Description: 查询指定城市下支持主题派对的门店列表。当用户选择了城市后，需要查看该城市有哪些门店可举办生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动时",
    "description": "Description: 查询指定城市下支持主题派对的门店列表。当用户选择了城市后，需要查看该城市有哪些门店可举办生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动时使用\nPreconditions：\n- 必须先通过 query-party-city 获取城市code和经纬度\n- 必须先确定spuId（从 mall-points-products 获取或从 mall-product-detail获取）\nInput:\n- code: 城市code, 城市下的门店列表获取(query-party-city)\n- latitude: 纬度, 城市下的门店列表获取(query-party-city)\n- longitude: 经度, 城市下的门店列表获取(query-party-city)\n- spuId: spuId, 从 mall-points-products 或 mall-product-detail 获取",
    "args": [
      {
        "name": "code",
        "type": "string",
        "required": true,
        "desc": "城市code"
      },
      {
        "name": "latitude",
        "type": "number",
        "required": false,
        "desc": "纬度，从 query-party-city 返回结果的 data[].latitude 获取"
      },
      {
        "name": "longitude",
        "type": "number",
        "required": false,
        "desc": "经度，从 query-party-city 返回结果的 data[].longitude 获取"
      },
      {
        "name": "spuId",
        "type": "number",
        "required": false,
        "desc": "spuId，从 mall-points-products 或 mall-product-detail 获取"
      }
    ]
  },
  {
    "name": "query-party-store-date",
    "order": 33,
    "group": "活动派对",
    "title": "可约日期",
    "use": "门店可预约的日期",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 查询指定门店支持生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动的可预约日期列表。当用户选择了门店后，需要查看该门店哪些日期可预约时使用。",
    "description": "Description: 查询指定门店支持生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动的可预约日期列表。当用户选择了门店后，需要查看该门店哪些日期可预约时使用。\nWhen：\n- 用户询问\"这家店哪天可以预约\"\n- 用户询问\"可预约日期\"\n- 用户询问\"查看门店日历\"\n- 用户询问\"哪天有场次\"\n- 用户选择门店后询问日期\nPreconditions：\n- 必须确定 spuId（从 mall-points-products 获取或从 mall-product-detail获取）\n- 必须先通过 query-party-store 获取 storeCode\nInput:\n- storeCode: 门店code, 城市下的门店列表获取(query-party-store)\n- spuId: spuId, 需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId",
    "args": [
      {
        "name": "spuId",
        "type": "number",
        "required": true,
        "desc": "spuId"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店code"
      }
    ]
  },
  {
    "name": "query-party-store-session",
    "order": 34,
    "group": "活动派对",
    "title": "活动场次",
    "use": "某天有哪些场次",
    "readonly": true,
    "ttlMs": 600000,
    "summary": "Description: 查询指定门店、指定日期下的生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动场次列表。当用户选择了日期后，需要查看当天有哪些场次可预约时使用",
    "description": "Description: 查询指定门店、指定日期下的生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动场次列表。当用户选择了日期后，需要查看当天有哪些场次可预约时使用。\nWhen：\n- 用户询问\"查看主题活动场次列表\"\n- 用户询问\"几点有场次\"\nPreconditions：\n- 必须确定 spuId（从 mall-points-products 获取或从 mall-product-detail获取）\n- 必须先通过 query-party-store 获取 storeCode\n- 必须先通过 query-party-store-date 获取 dateStr\nInput:\n- spuId: spuId, 需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId\n- storeCode: 门店code, 城市下的门店列表获取(query-party-store)\n- dateStr: 门店日期, 城市下的门店列表获取(query-party-store-date)",
    "args": [
      {
        "name": "dateStr",
        "type": "string",
        "required": true,
        "desc": "门店日期"
      },
      {
        "name": "spuId",
        "type": "number",
        "required": true,
        "desc": "spuId"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": true,
        "desc": "门店code"
      }
    ]
  },
  {
    "name": "party-order-create",
    "order": 35,
    "group": "活动派对",
    "title": "派对下单",
    "use": "创建派对/体验营订单（写操作）",
    "readonly": false,
    "ttlMs": 0,
    "summary": "Description: 创建生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动, 仅支持shopId=5（从 mall-product-detail 获取）的调用，",
    "description": "Description: 创建生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动, 仅支持shopId=5（从 mall-product-detail 获取）的调用，\n  支持包场(partyType=1)、拼团(partyType=2)两种场景下单，必须先确认场次类型，必填 (1：包场，2：拼团)\n\nWhen:\n- 用户询问\"生日类派对/主题类派对/麦麦体验营/品鉴会/读书会/积分兑换活动\"\nPreconditions：\n- 仅支持shopId=5（从 mall-product-detail 获取）的调用\n- 每一步完成后，必须等待用户明确选择，再继续下一步。不得跳步\nInput:\n- spuId: spuId, 需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的spuId（必填））\n- skuId: 商品SKU ID，需要从查询可兑换商品列表（从 mall-points-products 获取）或查询商品详情（从 mall-product-detail 获取）中让用户选择一个spu，获取对应的skuId（必填）\n- partyType:\n  派对类型（必填），判断规则：\n  -若商品 partyType=1，则 partyType=1（仅包场）\n  -若商品 partyType=2，则 partyType=2（仅拼团）\n  -若商品 partyType=-1，需询问用户后确认（1：包场，2：拼团）\n- code: 城市code，城市下的门店列表获取(query-party-city)（必填）\n- storeCode: 门店code, 城市下的门店列表获取(query-party-store)（必填）\n- dateStr: 门店日期, 城市下的门店列表获取(query-party-store-date)（必填）\n- id: 场次id, 查询主题活动场次列表(query-party-store-session)（必填）\n- timeStart: 场次开始时间, 查询主题活动场次列表(query-party-store-session)（必填）\n- timeEnd: 场次结束时间, 查询主题活动场次列表(query-party-store-session)（必填）\n- leftNum: 场次余位, 查询主题活动场次列表(query-party-store-session)（必填）\n- count: 参与人数（必填）\nNext：\n- 引导用户：\"确认信息，可以说'创建订单'进行下单\"",
    "args": [
      {
        "name": "code",
        "type": "string",
        "required": false,
        "desc": "城市code"
      },
      {
        "name": "count",
        "type": "integer",
        "required": false,
        "desc": "count"
      },
      {
        "name": "dateStr",
        "type": "string",
        "required": false,
        "desc": "店铺日期"
      },
      {
        "name": "id",
        "type": "number",
        "required": false,
        "desc": "场次Id"
      },
      {
        "name": "leftNum",
        "type": "integer",
        "required": false,
        "desc": "场次余位"
      },
      {
        "name": "partyTimeInfo",
        "type": "object",
        "required": false,
        "desc": "场次信息"
      },
      {
        "name": "partyType",
        "type": "integer",
        "required": true,
        "desc": "派对类型，1-包场，2-拼团"
      },
      {
        "name": "skuId",
        "type": "number",
        "required": false,
        "desc": "skuId"
      },
      {
        "name": "spuId",
        "type": "number",
        "required": false,
        "desc": "spuId"
      },
      {
        "name": "storeCode",
        "type": "string",
        "required": false,
        "desc": "门店"
      },
      {
        "name": "timeEnd",
        "type": "string",
        "required": false,
        "desc": "场次结束时间"
      },
      {
        "name": "timeStart",
        "type": "string",
        "required": false,
        "desc": "场次开始时间"
      }
    ]
  }
];

const BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

export function getTool(name: string): ToolMeta | undefined {
  return BY_NAME.get(name);
}

export function isKnownTool(name: string): boolean {
  return BY_NAME.has(name);
}

export function isReadonlyTool(name: string): boolean {
  return BY_NAME.get(name)?.readonly === true;
}

export function catalogStats(): {
  total: number;
  readonly: number;
  write: number;
  byGroup: Array<{ group: ToolGroup; total: number; readonly: number }>;
} {
  const byGroup = TOOL_GROUPS.map((group) => {
    const list = TOOL_CATALOG.filter((t) => t.group === group);
    return { group, total: list.length, readonly: list.filter((t) => t.readonly).length };
  });
  return {
    total: TOOL_CATALOG.length,
    readonly: TOOL_CATALOG.filter((t) => t.readonly).length,
    write: TOOL_CATALOG.filter((t) => !t.readonly).length,
    byGroup,
  };
}
