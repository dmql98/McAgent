/**
 * 「麦门知己」前端类型定义
 *
 * 与 server/src/types/contract.ts、server/src/services/explorer.service.ts 一一对应。
 * 后端改了字段，这里跟着改，tsc 会立刻报错 —— 这就是上 TS 的原因：
 * 35 个工具的返回结构里有 currentMouthExpirePoint（服务端把 Month 拼成 Mouth）
 * 这种坑，靠肉眼是看不出来的。
 */

/* ============================================================
 * 基础
 * ============================================================ */

export type Mood = '烦躁' | '疲惫' | '低落' | '开心' | '平淡' | '庆祝';
export type Fulfillment = '自取' | '外送' | '堂食';

export type ErrorCode =
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'MCP_DOWN'
  | 'LLM_FAILED'
  | 'GUEST_LIMIT_REACHED'
  | 'ORDER_CONFLICT'
  /** 门店/账户明确拒绝（限购、售罄、打烊）。与 CONFLICT 的区别是**别给重试** */
  | 'ORDER_REJECTED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'NEED_LOGIN'
  | 'NEED_LOCATION'
  | 'NEED_ADDRESS'
  | 'INTERNAL'
  | 'NETWORK'
  | 'TIMEOUT';

export interface UserProfile {
  nickname?: string;
  birthday?: string;
  starSign?: string;
  taboo: string[];
}

export interface MeResponse {
  userId: string;
  profile?: UserProfile;
  hasToken: boolean;
  needOnboarding: boolean;
  autoConfirm: boolean;
}

export interface LoginResponse {
  ok: true;
  userId: string;
  isNew: boolean;
  needOnboarding: boolean;
}

/* ============================================================
 * 记忆（保留的核心能力）
 * ============================================================ */

export type MemoryCardKey = 'profile' | 'taste' | 'habits' | 'moodDiary' | 'rituals';

export interface MemoryEntryRef {
  key: string;
  label: string;
}

export interface MemoryCard {
  key: MemoryCardKey;
  title: string;
  icon: string;
  lines: string[];
  entries: MemoryEntryRef[];
}

export interface MemoryLocation {
  hasLocation: boolean;
  city?: string | null;
  district?: string | null;
  source?: 'gps' | 'manual';
  searchCity?: string | null;
  searchKeyword?: string | null;
}

export interface MemoryResponse {
  cards: MemoryCard[];
  updatedAt: number;
  privacyNote: string;
  location: MemoryLocation;
}

export interface LocationInfo {
  hasLocation: boolean;
  city?: string | null;
  district?: string | null;
  source?: 'gps' | 'manual';
  lat?: number;
  lng?: number;
}

/* ============================================================
 * 聊天
 * ============================================================ */

export interface MenuItem {
  /** 该项小计，不是单价 */
  price: number;
  name: string;
  spec?: string;
  why?: string;
}

export interface BudgetInfo {
  limit: number;
  remaining: number;
  ok: boolean;
}

export interface ChatReplyMeta {
  store: string;
  slot: string;
  title: string;
  fulfillment?: Fulfillment;
}

/** 外送费用明细（仅 fulfillment='外送' 时有值） */
export interface DeliveryFeeInfo {
  /** 配送费 */
  delivery: number;
  /** 打包服务费 */
  packing: number;
  /** 起送门槛 */
  minOrder?: number;
}

export type ReplyAction = 'confirm' | 'refine' | 'reorder';

export interface ChatReply {
  hook: string;
  meta: ChatReplyMeta;
  menu: MenuItem[];
  /** 券后实付（外送场景已含配送费与打包费） */
  total: number;
  original?: number;
  budget?: BudgetInfo;
  nutrition?: string;
  quote: string;
  actions: ReplyAction[];
  upsell?: 'login';
  dataSource?: 'mcp' | 'cache' | 'offline';
  clarifyOnly?: boolean;
  /** 外送费用明细，前端要单独列一行 */
  deliveryFee?: DeliveryFeeInfo;
  /** 外送送达地址 */
  address?: string;
}

/* ============================================================
 * 购物车
 * ============================================================ */

/**
 * 购物车的一行。
 *
 * 注意 `price` 是**单价**，不是小计 —— 和 MenuItem 相反。
 * （MenuItem 来自"一次推荐的结果"，用成小计方便直接合计；
 *   购物车要能改数量，只有单价才改得动。）
 */
export interface CartItem {
  id: string;
  productId: string;
  name: string;
  price: number;
  originalPrice?: number;
  qty: number;
  spec?: string;
  why?: string;
  modifications?: string[];
  selected?: string[];
}

export interface Cart {
  items: CartItem[];
  /** 商品合计（不含配送费） */
  subtotal: number;
  deliveryFee?: DeliveryFeeInfo;
  /** 应付合计（外送已含配送费与打包费） */
  total: number;
  fulfillment: Fulfillment;
  store?: string;
  storeCode?: string;
  addressId?: string;
  address?: string;
  /** 件数（qty 之和） */
  count: number;
  updatedAt: number;
}

export interface SearchProduct {
  productId: string;
  name: string;
  price: number;
  modifications?: string[];
}

export type StageName = 'intent' | 'context' | 'knowledge' | 'menu' | 'coupon' | 'review' | 'compose';

export type SseEvent =
  | { type: 'stage'; stage: StageName; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reply'; payload: ChatReply }
  | { type: 'done'; chatId: string }
  | { type: 'error'; error: ErrorCode; message: string };

export interface OrderInfo {
  orderId: string;
  total: number;
  store?: string;
  payUrl?: string;
  reused?: boolean;
  status: 'created' | 'paid' | 'progress' | 'done' | 'canceled';
  progressText?: string;
  fulfillment?: Fulfillment;
  address?: string;
  deliveryFee?: DeliveryFeeInfo;
}

/** 外送地址（服务端返回的 phone 已脱敏） */
export interface DeliveryAddress {
  addressId: string;
  contactName: string;
  phone: string;
  fullAddress: string;
  isDefault?: boolean;
  tag?: string;
  gender?: string;
}

export interface AddressListResponse {
  addresses: DeliveryAddress[];
  defaultId?: string;
}

export interface CreateAddressRequest {
  city: string;
  contactName: string;
  gender?: string;
  phone: string;
  address: string;
  addressDetail: string;
}

/* ============================================================
 * Explorer：每个区块都带 meta，把「数据从哪来」画到界面上
 * ============================================================ */

export interface BlockMeta {
  /** MCP 工具名，如 query-nearby-stores */
  tool: string;
  title: string;
  /** 是否命中网关缓存 */
  cached: boolean;
  costMs: number;
  /** mcp=刚查的 / cache=命中缓存 / empty=没解析出条目 */
  source: 'mcp' | 'cache' | 'empty';
  /** 服务端原始返回片段，用来给"看见 MCP 到底回了什么" */
  rawPreview?: string;
  /** source=empty 时的原因 */
  reason?: string;
}

export interface Block<T> {
  meta: BlockMeta;
  data: T;
}

export interface StoreCard {
  storeCode: string;
  name: string;
  address?: string;
  city?: string;
  distance?: number;
  distanceText?: string;
  open?: boolean;
  businessStatus?: string;
  businessHours?: string;
  reservation?: boolean;
  reservationOptions?: string[];
  beCode?: string;
  image?: string;
  tags: string[];
}

export interface MenuCard {
  code: string;
  name: string;
  image?: string;
  price: number;
  originalPrice?: number;
  discountType?: string;
  available: boolean;
  tags: string[];
  category?: string;
}

export interface MenuAll {
  categories: Array<{ name: string; items: MenuCard[] }>;
  frequent: MenuCard[];
  total: number;
}

export interface MealRoundOption {
  name: string;
  diffPrice?: string;
  default?: boolean;
}

export interface MealRoundChoice {
  code?: string;
  name: string;
  isDefault: boolean;
  diffPrice?: string;
  supportModify: boolean;
  options: MealRoundOption[];
}

export interface MealDetail {
  code: string;
  name: string;
  image?: string;
  description?: string;
  supportModify: boolean;
  rounds: Array<{ name: string; choices: MealRoundChoice[] }>;
  combo: Array<{ name: string; quantity?: number; image?: string }>;
}

export interface NutritionRow {
  productName: string;
  nutritionDescription?: string;
  energyKcal?: number;
  energyKj?: number;
  protein?: number;
  fat?: number;
  carbohydrate?: number;
  sodium?: number;
  calcium?: number;
}

export interface CouponCard {
  id: string;
  title: string;
  price?: number;
  priceNote?: string;
  validity?: string;
  receivedAt?: string;
  tags: string[];
  image?: string;
  status?: string;
  code?: string;
  products?: string[];
  kind: 'card' | 'claimable' | 'store';
  raw?: string;
}

export interface AccountInfo {
  available: number;
  /** 注意：服务端字段名是 currentMouthExpirePoint（Mouth 不是 Month） */
  expiringThisMonth: number;
  accumulated: number;
  used: number;
  expired: number;
  frozen: number;
  level?: string;
  memberNo?: string;
}

export interface LotteryInfo {
  activityName?: string;
  activityCode?: string;
  status?: string;
  beginTime?: string;
  endTime?: string;
  drawPoint?: number;
  drawTypeText?: string;
  availableTimes?: number;
  availablePoint?: number;
  decision?: {
    eligible?: boolean;
    eligibleText?: string;
    nextConsumption?: string;
    fallback?: string;
  };
  prizes: Array<{ name: string; image?: string; typeText?: string }>;
}

export interface PrizeItem {
  id: string;
  name: string;
  image?: string;
  status?: string;
  time?: string;
  remind?: string;
  typeText?: string;
}

export interface MallProduct {
  spuId?: number | string;
  name: string;
  image?: string;
  points?: number;
  originalPoints?: number;
  category?: string;
  desc?: string;
  stock?: number;
  tags: string[];
}

export interface MallSku {
  skuId?: number | string;
  name?: string;
  points?: number;
  stock?: number;
  spec?: string;
}

export interface MallProductDetail {
  spuId?: number | string;
  name: string;
  image?: string;
  description?: string;
  images: string[];
  skus: MallSku[];
}

export interface OrderItemCard {
  name: string;
  quantity?: number;
  price?: number;
  /** 商城订单用积分计价，不是金额 */
  points?: number;
  image?: string;
  combo?: string[];
}

export interface OrderCard {
  orderId: string;
  status?: string;
  statusText?: string;
  storeName?: string;
  storeAddress?: string;
  total?: number;
  realTotal?: number;
  /** 商城订单没有金额，只有件数 */
  totalCount?: number;
  createdAt?: string;
  payUrl?: string;
  items: OrderItemCard[];
  extra: Array<{ label: string; value: string }>;
}

export interface CampaignDay {
  date: string;
  label?: string;
  activities: Array<{ title: string; desc?: string; image?: string; timeText?: string; tags: string[] }>;
}

export interface PartyCity {
  code: string;
  name: string;
  latitude?: number;
  longitude?: number;
}

export interface PartyStore {
  storeCode: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export interface PartyDate {
  date: string;
  weekday?: string;
  available?: boolean;
  tag?: string;
}

export interface PartySession {
  sessionId?: string;
  name: string;
  startTime?: string;
  endTime?: string;
  price?: number;
  /** 剩余名额（服务端字段 leftNum） */
  stock?: number;
  /** 成团人数下限（partyMin） */
  minPeople?: number;
  /** 成团人数上限（partyMax） */
  maxPeople?: number;
  status?: string;
}

export interface AddressCard {
  addressId: string;
  contactName?: string;
  phone?: string;
  city?: string;
  address?: string;
  detail?: string;
  gender?: string;
  tag?: string;
  isDefault?: boolean;
}

export interface PriceBreakdown {
  total: number;
  original?: number;
  discount?: number;
  productTotal?: number;
  deliveryFee?: number;
  packingFee?: number;
  tablewareFee?: number;
  items: Array<{ name?: string; code?: string; quantity?: number; subtotal?: number; originalSubtotal?: number }>;
  takeWays: Array<{ code: string; title: string }>;
}

/* ============================================================
 * 工具目录（35 个）
 * ============================================================ */

export type ToolGroup = '定位门店' | '菜单选品' | '优惠券' | '点餐交易' | '积分商城' | '活动派对';

export interface ToolArg {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
}

export interface ToolMeta {
  name: string;
  order: number;
  group: ToolGroup;
  title: string;
  /** 一句话用途 */
  use: string;
  readonly: boolean;
  ttlMs: number;
  summary: string;
  description: string;
  args: ToolArg[];
  /** 服务端补的：TTL 人类可读，如「10 分钟」 */
  ttlText?: string;
  /** 网关真实生效的 TTL */
  gatewayTtl?: number;
  isWrite?: boolean;
}

export interface CatalogStats {
  total: number;
  readonly: number;
  write: number;
  byGroup: Array<{ group: ToolGroup; count: number }>;
}

export interface ToolsResponse {
  groups: ToolGroup[];
  stats: CatalogStats;
  tools: ToolMeta[];
  rate: RateStats;
}

export interface RateStats {
  perUserLimit?: number;
  globalLimit?: number;
  users?: number;
  [k: string]: unknown;
}

export interface ToolCallResult {
  meta: BlockMeta;
  /** 能解析出 JSON 就有，否则 null */
  json: unknown;
  /** 服务端原始文本 —— 工具台主视图，让用户看见 MCP 到底回了什么 */
  text: string;
  table?: { columns: string[]; rows: Array<Record<string, string>> };
}

/* ============================================================
 * 各面板的响应体
 * ============================================================ */

export interface OverviewResponse {
  store: { storeCode: string; name: string; city?: string } | null;
  storeBlock: Block<StoreCard | null> | null;
  time: Block<{
    datetime?: string;
    formatted?: string;
    dayOfWeek?: string;
    timezone?: string;
    timestamp?: number;
  } | undefined>;
  account: Block<AccountInfo | undefined>;
  coupons: {
    card: number;
    claimable: number;
    cardBlock: BlockMeta;
    claimableBlock: BlockMeta;
  };
  menu: { total: number; categories: number; meta: BlockMeta | null };
  memory: {
    nickname: string | null;
    taboo: string[];
    topItems: string[];
    usualStore: string | null;
    usualCity: string | null;
    moods: Array<{ date: string; mood: Mood }>;
  };
  tools: CatalogStats & {
    rate: RateStats;
    gateway: Record<string, unknown>;
  };
}

export interface StoresResponse extends Block<StoreCard[]> {
  [k: string]: unknown;
}

export interface MenuResponse extends Block<MenuAll> {
  storeCode: string;
  storeName: string;
}

export interface MealResponse extends Block<MealDetail | undefined> {
  storeCode: string;
}

export interface NutritionResponse {
  meta: BlockMeta;
  total: number;
  filtered: number;
  q: string;
  rows: NutritionRow[];
  heaviest: NutritionRow[];
  lightest: NutritionRow[];
}

export interface CouponsResponse {
  store: { storeCode: string; name: string } | null;
  card: Block<CouponCard[]>;
  claimable: Block<CouponCard[]>;
  storeCoupons: Block<CouponCard[]>;
}

export interface PointsResponse {
  account: Block<AccountInfo | undefined>;
  lottery: Block<LotteryInfo | undefined>;
  prizes: Block<{ items: PrizeItem[]; hasMore: boolean }>;
}

export interface MallResponse extends Block<MallProduct[]> {
  cat: string;
}

export interface OrdersResponse {
  foodOrders: Block<OrderCard[]>;
  mallOrders: Block<OrderCard[]>;
}

export interface OrderDetailResponse {
  kind: 'food' | 'mall';
  detail: Block<OrderCard | undefined>;
  survey: Block<Record<string, unknown> | undefined>;
}

export interface CampaignsResponse extends Block<CampaignDay[]> {
  date: string;
}

export interface PartiesResponse {
  cities: Block<PartyCity[]>;
  spuId: number | null;
  /** 没给 spuId 时后端会置 true，前端据此提示"先选派对商品" */
  needSpuId?: boolean;
}

/** 派对商品：从积分商城里筛出来的、可以走派对预约链路的商品 */
export interface PartyProduct {
  spuId?: number | string;
  name: string;
  category?: string;
  image?: string;
  points?: number;
}

export interface PartyProductsResponse extends Block<PartyProduct[]> {
  total?: number;
}

export interface PartyStoresResponse extends Block<PartyStore[]> {
  code: string;
}

export interface PartyDatesResponse extends Block<PartyDate[]> {
  storeCode: string;
  spuId: number;
}

export interface PartySessionsResponse extends Block<PartySession[]> {
  storeCode: string;
  spuId: number;
  dateStr: string;
}
