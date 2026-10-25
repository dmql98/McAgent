/**
 * 「麦门知己」前后端共享契约类型
 *
 * 规则：
 * - API 层出入参全部 camelCase
 * - DB 层列名全部 snake_case，转换在 service 层做
 * - 金额单位为元（number），保留两位小数由渲染层决定
 * - ChatReply.menu[].price 语义 = 该项小计（不是单价）
 *
 * 本文件零依赖、纯类型，可被 import type 直接使用。
 */

/* ============================================================
 * 基础枚举
 * ============================================================ */

export type Mood = '烦躁' | '疲惫' | '低落' | '开心' | '平淡' | '庆祝';

export type TimeSlot = '早餐' | '午餐' | '下午茶' | '夜市' | '深夜';

/**
 * 履约方式。语义严格对应麦当劳 MCP 的 beType：
 * - 自取  → beType=1，orderType=1，用 query-nearby-stores，不传 beCode
 * - 外送  → beType=2，orderType=2，用 delivery-query-stores，必传 beCode + addressId
 * - 堂食  → 到店场景下的取餐方式，本质仍是 beType=1
 *
 * 外送与到店是**两套商品编码**（实测同一门店 90 个到店商品里，
 * 有 77 个在外送菜单里不存在），所以选品必须按对应场景的菜单来做。
 */
export type Fulfillment = '自取' | '外送' | '堂食';

/** 统一错误码 */
export type ErrorCode =
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'MCP_DOWN'
  | 'LLM_FAILED'
  | 'GUEST_LIMIT_REACHED'
  | 'ORDER_CONFLICT'
  /**
   * 门店/账户明确拒绝了下单（限购、售罄、打烊等）。
   *
   * 与 ORDER_CONFLICT 的区别在**要不要重试**：
   * CONFLICT 是"我们这边状态对不上，刷新可能就好"，
   * REJECTED 是对方说了不行，重试没用，前端不该给重试按钮。
   */
  | 'ORDER_REJECTED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  /**
   * 需要先登录（粘贴麦当劳 Token）才能拿到真实数据。
   *
   * 为什么单独一个码而不是复用 UNAUTHORIZED：
   * 我们没有本地账号体系，身份就是用户的麦当劳 Token。
   * 查门店/查菜单/下单全部依赖它，所以"未登录"在产品上是
   * "还没接上麦当劳"，前端应引导粘贴 Token，而不是弹通用登录框。
   */
  | 'NEED_LOGIN'
  /**
   * 需要定位授权。
   *
   * 麦当劳查门店只接受「城市 + 关键词」，不认经纬度。
   * 没有城市就一个门店都查不到，所以前端必须能识别这个码并引导用户授权定位。
   */
  | 'NEED_LOCATION'
  /**
   * 需要配送地址。
   *
   * 外送（麦乐送 beType=2）必须先有 addressId 才能查可配送门店，
   * 进而查菜单、算价、下单。没有地址时前端应弹「选地址 / 新建地址」，
   * 而不是笼统报一个 MCP 错误。
   */
  | 'NEED_ADDRESS'
  | 'INTERNAL';

/** 统一错误响应体 */
export interface ApiError {
  error: ErrorCode;
  message: string;
  retriable?: boolean;
}

/** 订单状态（对外统一语义，内部映射 MCP 原始值） */
export type OrderStatus = 'created' | 'paid' | 'progress' | 'done' | 'canceled';

/* ============================================================
 * 用户与账号
 * ============================================================ */

export interface UserProfile {
  nickname?: string;
  /** ISO 日期 YYYY-MM-DD */
  birthday?: string;
  starSign?: string;
  /** 忌口 / 过敏 */
  taboo: string[];
}

export interface LoginRequest {
  token: string;
}

export interface LoginResponse {
  ok: true;
  userId: string;
  isNew: boolean;
  needOnboarding: boolean;
}

export interface MeResponse {
  userId: string;
  profile?: UserProfile;
  hasToken: boolean;
  needOnboarding: boolean;
  /** 免确认一键下单开关，默认 false */
  autoConfirm: boolean;
}

export interface ProfileUpdateRequest {
  nickname?: string;
  birthday?: string;
  taboo?: string[];
}

/* ============================================================
 * 记忆结构
 * ============================================================ */

export interface MemoryTaste {
  /** 甜度偏好 0-3，undefined 表示未知 */
  sweetness?: number;
  /** 辣度偏好 0-3 */
  spicy?: number;
  /** 温度偏好 */
  temp?: ('冰' | '常温' | '热')[];
  /** 常点单品 Top5，按频次降序 */
  topItems: string[];
  /** 特制习惯，如 "可乐去冰" */
  customs: string[];
}

export interface MemoryHabits {
  /** 历史点单摘要，最多 50 条 */
  orders: OrderBrief[];
  /** 预算区间 [min, max] */
  budgetRange?: [number, number];
  /** 常去时段 */
  usualSlots: string[];
  /** 常去门店名 */
  usualStore?: string;
  /** 常去城市（门店搜索的主要依据） */
  usualCity?: string;
  /** 定位信息（用户授权后记录） */
  location?: UserLocation;
}

/**
 * 用户定位
 *
 * 为什么存这个：麦当劳 query-nearby-stores **不接受经纬度**，
 * 只接受「城市 + 关键词」。所以浏览器拿到的坐标必须换成城市名/商圈名，
 * 才能真正用于查门店。这里同时保留原始坐标，便于以后地图能力升级。
 */
export interface UserLocation {
  /** 纬度 */
  lat: number;
  /** 经度 */
  lng: number;
  /** 城市名，如「深圳市」—— MCP 的 city 入参 */
  city?: string;
  /**
   * 商圈/地标关键词，如「留仙洞」—— MCP 的 keyword 入参。
   * 这是让门店列表"围着用户转"的关键。
   */
  district?: string;
  /** 定位来源 */
  source: 'gps' | 'manual';
  /** 定位时间戳 */
  updatedAt: number;
}

export interface OrderBrief {
  /** ISO 日期 */
  date: string;
  items: string[];
  total: number;
  store?: string;
}

export interface MoodEntry {
  /** ISO 日期 */
  date: string;
  mood: Mood;
  /** 用户原话，脱敏截断 200 字 */
  trigger: string;
  recommended?: string;
  /** 用户反馈，如 "治愈" */
  feedback?: string;
}

export interface MemoryRituals {
  /** 上次记录的节气，如 "霜降" */
  lastSolarTerm?: string;
  /** 水逆状态 */
  retrograde?: { active: boolean; startDate?: string; dayIndex?: number };
  /** 生日提醒，ISO 日期 */
  birthdayReminder?: string;
}

export interface UserMemory {
  /** schema 版本，便于后续迁移 */
  schemaVersion: number;
  /** 乐观锁版本号，每次 save 自增 */
  version: number;
  profile: UserProfile;
  taste: MemoryTaste;
  habits: MemoryHabits;
  moodDiary: MoodEntry[];
  rituals: MemoryRituals;
  updatedAt: number;
}

/** 给 LLM 用的记忆快照（精简版，控制 token < 400） */
export interface MemorySnapshot {
  nickname?: string;
  starSign?: string;
  birthdayMonth: boolean;
  taboo: string[];
  tasteTags: string[];
  topItems: string[];
  customs: string[];
  recentMoods: { date: string; mood: Mood }[];
  usualStore?: string;
  /**
   * 常去城市。
   *
   * 为什么需要：麦当劳 query-nearby-stores 只接受「城市 + 关键词」，
   * 不接受经纬度，所以必须存城市名才能定位门店。
   */
  usualCity?: string;
  /**
   * 门店搜索关键词（商圈 / 地标 / 具体店名）。
   * 来自定位反查出的 district，或用户实际点过的店名。
   */
  usualKeyword?: string;
  budgetRange?: [number, number];
  retrogradeActive: boolean;
}

/** 记忆管理页的卡片结构 */
export interface MemoryCard {
  key: MemoryCardKey;
  title: string;
  icon: string;
  /** 展示行，每行一个 */
  lines: string[];
  /** 可删除的条目：每一项对应一个 entryKey */
  entries: MemoryEntryRef[];
}

export type MemoryCardKey = 'profile' | 'taste' | 'habits' | 'moodDiary' | 'rituals';

export interface MemoryEntryRef {
  /** 传给 DELETE /api/memory/:key 的 key，形如 "taste.topItems.麦麦鸡" */
  key: string;
  label: string;
}

export interface MemoryResponse {
  cards: MemoryCard[];
  updatedAt: number;
  /** 数据只存在你自己的账号里 */
  privacyNote: string;
}

/* ============================================================
 * 意图解析
 * ============================================================ */

export interface ExplicitConstraints {
  people?: number;
  budget?: number;
  /** 忌口/过敏，硬约束 */
  taboo: string[];
  /** 口味偏好，软约束 */
  taste: string[];
  fulfillment?: Fulfillment;
  /** 原始时间表述，如 "明天中午" */
  timeHint?: string;
  /** 解析出的目标日期 ISO */
  targetDate?: string;
}

/**
 * 意图清晰度 —— 决定走不走旁路。
 *
 *   clear：用户已经把"吃什么"讲明白了（「我要吃辣」「3 个人 50 块」），
 *          直接进主 loop 第 ② 步查真实菜单，不需要再做背景推断。
 *   vague：用户只给了状态，没给约束（「很烦」「今天心情不错」「给我点个午餐」），
 *          先走旁路（用户知识 + 当下时间）推出一份判断结论，再导入主 loop。
 *
 * ⚠️ 「给我点个午餐」是 vague 而不是 clear —— 它表态了"要吃饭"，
 * 但没说什么口味、几个人、多少钱。早期版本把"表态点餐"当成 clear，
 * 于是直接选品，选出来的东西纯靠规则猜；新架构下它该走旁路，
 * 让模型结合记忆和时段判一次。**但 vague 不等于要反问**：
 * 旁路存在的意义就是替用户把这一句补完，而不是把问题甩回给用户。
 */
export type IntentClarity = 'clear' | 'vague';

export interface ParsedIntent {
  explicit: ExplicitConstraints;
  mood: Mood | null;
  /** 0-1 */
  moodConfidence: number;
  /** 是否该反问（只在旁路也失手时才为 true，是降级路径而非常规路径） */
  needsClarify: boolean;
  clarifyQuestion?: string;
  /** 是否命中极端低落关键词，触发温和模式 */
  safetyMode: boolean;
  /** 解析来源，便于调试 */
  source: 'rule' | 'llm' | 'fallback';
  raw: string;
  /** 意图清晰度，决定是否走旁路 */
  clarity: IntentClarity;
  /** 是否在表达"给我点一单" */
  orderIntent: boolean;
  /** 模型给的一句话判断依据，只用于日志与调试 */
  reasoning?: string;
  /**
   * 旁路推断出的**参考**预算（不是用户说的）。
   *
   * 为什么必须和 `explicit.budget` 分开：
   *   `explicit.budget` 的语义是"用户说了这个数"，它会
   *   ① 在回复卡片上显示预算条、② 触发超预算重选、③ 落进记忆当事实。
   *   旁路从"历史消费区间"推出来的数字如果混进去，用户会看到
   *   一个自己从没说过的预算被当成硬指标 —— 而且模型每次推的数还不一样
   *   （实测同一句话推出过 87、88、87.5 三个版本），同一句输入会得到不同菜单。
   *
   * 所以它只是个**提示**：不进 explicit、不触发重选、不落库。
   * 占位留着是因为文案层会用它说"按你平时的价位"，
   * 价位偏向本身由 snapshot.budgetRange 的打分项负责，不需要再来一套。
   */
  softBudget?: number;
  /** 旁路的判断结论（一句话），给文案生成当参考，不落库 */
  contextRead?: string;
  /** 旁路判定该避开的（选品降权用） */
  contextAvoid?: string[];
}

/* ============================================================
 * 旁路：用户知识 + 时间背景推断
 * ============================================================ */

/**
 * 旁路结论。
 *
 * 定位：用户只说了状态（「很烦」）时，用一个模型结合**用户记忆**（常点、
 * 忌口、最近情绪、预算区间）和**当下时间**（时段、星期、节气、水逆）
 * 推出一份"这顿该给他配什么"的判断，然后**作为约束导入主 loop**。
 *
 * 它不是选品结果，也不产生商品名 —— 只产出倾向标签和推定参数，
 * 由确定性选品引擎去真实菜单里落地。
 */
export interface ContextAnalysis {
  /** 是否真的跑过旁路（false = 意图已明确，跳过） */
  ran: boolean;
  /** 对用户此刻状态的一句话判断，进日志和文案参考 */
  read: string;
  /** 推断的情绪（可为空，空则沿用意图解析的结论） */
  mood?: Mood;
  /** 口味倾向标签，直接并入 intent.explicit.taste */
  tasteHints: string[];
  /** 推断人数（用户没说时，由旁路按场景估，估不出就不填 → 主 loop 兜底 1 人） */
  people?: number;
  /** 推断预算（用户没说时，按记忆里的预算区间给一个） */
  budget?: number;
  /** 该避开的（比如"昨天刚吃过麦辣鸡腿堡，今天别再推"） */
  avoid: string[];
  /** 判断依据，每条都要能指到具体记忆或时间事实，禁止空话 */
  basis: string[];
}

/* ============================================================
 * 知识引擎
 * ============================================================ */

export interface SolarTerm {
  name: string;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  /** 意境描述 */
  imagery: string;
  /** 策略标签 */
  strategy: string[];
  /** 可推荐的品类关键词 */
  keywords: string[];
  /** 一句可直接用的节气文案 */
  blurb: string;
}

export interface StarSign {
  name: string;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  /** 食物性格 */
  personality: string;
  strategy: string[];
  /** 生日月专属玩法 */
  birthdayTactic: string;
}

export interface RetrogradeInfo {
  active: boolean;
  /** 水逆第几天，从 1 开始 */
  dayIndex: number;
  phase: 'start' | 'mid' | 'end';
  startDate: string;
  endDate: string;
}

export interface MoodStrategy {
  mood: Mood;
  /** 口味策略标签，如 ["甜","辣","冰"] */
  tasteStrategy: string[];
  /** 应避免的推荐方向 */
  avoid: string[];
  /** 回复温度：低落必须是温和 */
  warmth: '温和' | '正常' | '俏皮';
  /** 开场示例，给 LLM 做底稿 */
  sampleHook: string;
}

export interface StrategyContext {
  solarTerm: SolarTerm;
  starSign: StarSign | null;
  birthdayMonth: boolean;
  retrograde: RetrogradeInfo | null;
  mood: Mood | null;
  moodStrategy: MoodStrategy | null;
  timeSlot: TimeSlot;
  taboo: string[];
  /** 是否温和模式（极端低落） */
  safetyMode: boolean;
}

/* ============================================================
 * 菜单与回复
 * ============================================================ */

export interface MenuItem {
  name: string;
  /** 规格/数量/特制，如 "×2 · 去冰" */
  spec: string;
  /** 推荐理由，可空字符串 */
  why: string;
  /** 该项小计（不是单价） */
  price: number;
  originalPrice?: number;
  /** MCP 商品 id，下单必需 */
  productId?: string;
  /** MCP 特制项，下单必需 */
  modifications?: string[];
}

export interface BudgetInfo {
  limit: number;
  ok: boolean;
  remaining: number;
}

export interface ChatReplyMeta {
  /** 门店名 */
  store: string;
  /** 时段/取餐时间描述 */
  slot: string;
  /** 菜单标题，如 "你的「水逆急救单」" */
  title: string;
  /** 取餐方式 */
  fulfillment?: Fulfillment;
}

/** 外送费用明细（仅在 fulfillment='外送' 时有值） */
export interface DeliveryFeeInfo {
  /** 配送费 */
  delivery: number;
  /** 打包服务费 */
  packing: number;
  /** 起送门槛（拿不到就不填） */
  minOrder?: number;
}

export type ReplyAction = 'confirm' | 'refine' | 'reorder';

export interface ChatReply {
  /** 懂你开场，2-3 句。**关键词** 包裹的部分前端渲染为高亮 */
  hook: string;
  meta: ChatReplyMeta;
  menu: MenuItem[];
  /** 券后实付（外送场景已含配送费与打包费） */
  total: number;
  /** 原价合计 */
  original?: number;
  /** 有预算约束时才有 */
  budget?: BudgetInfo;
  /** 热量一句话 */
  nutrition?: string;
  /** 情绪收尾金句 */
  quote: string;
  actions: ReplyAction[];
  /** 访客模式专属标记 */
  upsell?: 'login';
  /** 数据来源标记，offline 表示 MCP 不可用走了兜底 */
  dataSource?: 'mcp' | 'cache' | 'offline';
  /** 反问场景：只返回 hook，不带菜单 */
  clarifyOnly?: boolean;
  /** 外送费用明细，前端要单独列一行给用户看 */
  deliveryFee?: DeliveryFeeInfo;
  /** 外送送达地址（给用户确认用） */
  address?: string;
}

/* ============================================================
 * SSE 事件
 * ============================================================ */

/**
 * SSE 阶段名。
 *
 * 与主 loop 一一对应：
 *   intent   ① LLM 解析意图（顺带判定 clarity）
 *   context  ①.5 旁路：模糊意图才跑，用户知识 + 当下时间 → 判断结论
 *   menu     ② 导入 MCP 真实数据
 *   review   ③ 依据用户输入 + 购物车结论做判断（模型判断，本地执行）
 *   coupon   ④ 算价
 *   compose  ⑤ 文案生成
 */
export type StageName = 'intent' | 'context' | 'knowledge' | 'menu' | 'coupon' | 'review' | 'compose';

export type SseEvent =
  | { type: 'stage'; stage: StageName; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reply'; payload: ChatReply }
  | { type: 'done'; chatId: string }
  | { type: 'error'; error: ErrorCode; message: string };

export interface ChatRequest {
  message: string;
  guest?: boolean;
  /**
   * 履约方式，对话一开始就要定下来。
   *
   * 为什么必须在一开始定：外送和到店是**两套商品编码**
   * （实测同一门店 90 个到店商品中有 77 个外送不存在），
   * 选品、算价、下单全链路都要按对应场景走，
   * 中途切换会导致菜单里的商品根本下不了单。
   */
  fulfillment?: Fulfillment;
  /** 外送必传：配送地址 ID（来自 delivery-query-addresses） */
  addressId?: string;
}

/* ============================================================
 * 订单
 * ============================================================ */

export interface OrderConfirmRequest {
  chatId: string;
  /**
   * 可选：覆盖对话时选的履约方式。
   * 不传则沿用 chat 里记录的 fulfillment（推荐，保持一致）。
   */
  fulfillment?: Fulfillment;
  /** 外送必传 */
  addressId?: string;
}

export interface OrderConfirmResponse {
  orderId: string;
  payUrl: string;
  total: number;
  store: string;
  /** 幂等命中：本次是复用已有订单，而非新建 */
  reused?: boolean;
  /** 本次实际使用的履约方式 */
  fulfillment?: Fulfillment;
  /** 送达地址（外送时有值） */
  address?: string;
  /** 外送费用明细 */
  deliveryFee?: DeliveryFeeInfo;
}

/* ============================================================
 * 外送地址
 * ============================================================ */

export interface DeliveryAddress {
  addressId: string;
  contactName: string;
  /** 已脱敏的手机号（服务端返回的就是 181****3971 形式） */
  phone: string;
  fullAddress: string;
  isDefault?: boolean;
  tag?: string;
  gender?: string;
}

export interface CreateAddressRequest {
  city: string;
  contactName: string;
  gender?: string;
  /** 11 位纯数字 */
  phone: string;
  /** 配送地址，如「清竹园9号楼」 */
  address: string;
  /** 门牌号，如「2单元508」 */
  addressDetail: string;
}

export interface OrderStatusResponse {
  orderId: string;
  status: OrderStatus;
  /** 给用户看的状态文案 */
  progressText: string;
  payUrl?: string;
  updatedAt: number;
  total?: number;
}

/* ============================================================
 * 购物车
 * ============================================================ */

/**
 * 购物车里的一行。
 *
 * 与 MenuItem 的区别：MenuItem 是「一次推荐的结果」（价格是小计、只读）；
 * CartItem 是「用户正在改的一单」（价格是**单价**、数量独立、可增删）。
 * 两者必须区分开，否则「把小计当单价 ×2」会让总额翻倍。
 */
export interface CartItem {
  /** 行 id。同一商品不同特制算两行，所以不能用 productId 当行 id */
  id: string;
  /** MCP 商品编码，下单必需 */
  productId: string;
  name: string;
  /** **单价**，不是小计 */
  price: number;
  originalPrice?: number;
  qty: number;
  /** 展示用规格，如 "去冰" */
  spec?: string;
  /** 推荐理由（来自对话推荐时才有） */
  why?: string;
  /** 可选特制项 */
  modifications?: string[];
  /** 已选特制项 */
  selected?: string[];
  /** 是否套餐 */
  combo?: boolean;
  /** 套餐自带的配角，用于说明「里面有饮料」 */
  includes?: string[];
}

export interface Cart {
  /** 未登录访客没有购物车（返回空车 + ownerless） */
  items: CartItem[];
  /** 商品合计（不含配送费） */
  subtotal: number;
  /** 外送费明细，仅外送有 */
  deliveryFee?: DeliveryFeeInfo;
  /** 应付合计（含配送费） */
  total: number;
  fulfillment: Fulfillment;
  store?: string;
  storeCode?: string;
  beCode?: string;
  addressId?: string;
  address?: string;
  /** 件数合计（qty 之和） */
  count: number;
  updatedAt: number;
}

export interface CartAddRequest {
  productId: string;
  qty?: number;
  spec?: string;
  selected?: string[];
  fulfillment?: Fulfillment;
  addressId?: string;
}

export interface CartUpdateRequest {
  qty?: number;
  spec?: string;
  selected?: string[];
}

/* ============================================================
 * 健康检查
 * ============================================================ */

export interface HealthResponse {
  ok: boolean;
  mcp: 'reachable' | 'unreachable';
}
