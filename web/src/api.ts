/**
 * API 客户端
 *
 * 覆盖后端全部接口：
 *   /api/auth      登录 / 登出 / 解绑 / me / profile
 *   /api/chat      SSE 对话
 *   /api/orders    建单 / 查询 / 取消
 *   /api/location  定位上报 / 查询 / 清除
 *   /api/memory    记忆读取 / 删除单条
 *   /api/explorer  35 工具数据面（18 个 GET + 2 个 POST）
 *   /api/menu      菜单（轻量版）
 *   /api/assets    券包 / 门店券 / 领券
 *
 * mock 由 `?mock=1` 打开，用于没有 Token 时演示界面。
 */
import { ApiError } from './lib/error';
import { consumeSseStream } from './lib/sse';
import type {
  AddressCard,
  AddressListResponse,
  CampaignsResponse,
  Cart,
  ChatReply,
  CouponsResponse,
  CreateAddressRequest,
  DeliveryAddress,
  ErrorCode,
  Fulfillment,
  LocationInfo,
  LoginResponse,
  MallProductDetail,
  MallResponse,
  MealResponse,
  MeResponse,
  MemoryResponse,
  MenuAll,
  MenuResponse,
  NutritionResponse,
  OrderDetailResponse,
  OrderInfo,
  OrdersResponse,
  OverviewResponse,
  PartiesResponse,
  PartyDatesResponse,
  PartyProductsResponse,
  PartySessionsResponse,
  PartyStoresResponse,
  PointsResponse,
  PriceBreakdown,
  SearchProduct,
  SseEvent,
  StageName,
  StoresResponse,
  ToolCallResult,
  ToolsResponse,
  UserProfile,
} from './types';

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/** 所有请求带 Cookie（JWT 是 httpOnly Cookie，前端拿不到也不该拿） */
const BASE: RequestInit = { credentials: 'include' };

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'TOKEN_INVALID', 'RATE_LIMITED', 'MCP_DOWN', 'LLM_FAILED', 'GUEST_LIMIT_REACHED',
  'ORDER_CONFLICT', 'ORDER_REJECTED', 'UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND', 'NEED_LOGIN',
  'NEED_LOCATION', 'NEED_ADDRESS', 'INTERNAL',
]);

/** 统一处理响应：HTTP 失败抛出带业务码的 ApiError */
async function unwrap<T>(res: Response): Promise<T> {
  const raw = await res.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const o = (body ?? {}) as Record<string, unknown>;
    const code = typeof o.error === 'string' && ERROR_CODES.has(o.error) ? (o.error as ErrorCode) : 'INTERNAL';
    const msg = typeof o.message === 'string' && o.message ? o.message : `请求失败（${res.status}）`;
    throw new ApiError(code, msg, res.status, o.retriable === true);
  }

  return body as T;
}

/** 包装网络层异常：fetch 本身失败（断网/DNS/超时）也要变成 ApiError */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...BASE, ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new ApiError(aborted ? 'TIMEOUT' : 'NETWORK', aborted ? '请求超时了' : '连接不上服务器');
  }
  return unwrap<T>(res);
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** 拼 query string，跳过 undefined/空串 */
function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------------ */
/* 真实实现                                                            */
/* ------------------------------------------------------------------ */

const realApi = {
  /* ---- 身份 ---- */
  login: (token: string) => post<LoginResponse>('/api/auth/login', { token }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  unbind: () => del<{ ok: true }>('/api/auth/unbind'),
  // 契约 §1.4：当前用户在 /api/me（挂在根下，不在 /api/auth 前缀里）。
  // 写成 /api/auth/me 会拿到 404，前端会把 404 当成"未登录"直接踢回登录页。
  me: () => get<MeResponse>('/api/me'),
  updateProfile: (patch: Partial<Pick<UserProfile, 'nickname' | 'birthday' | 'taboo'>>) =>
    // 契约 §1.5：改资料也在根下（PUT /api/profile），不在 /api/auth 前缀里
    put<{ profile: UserProfile }>('/api/profile', patch),

  /* ---- 对话（SSE） ---- */
  async chat(
    message: string,
    opts: {
      guest?: boolean;
      signal?: AbortSignal;
      /** 履约方式：对话开局就定（外送/到店是两套商品编码，中途不能换） */
      fulfillment?: Fulfillment;
      /** 外送必传：配送地址 ID */
      addressId?: string;
    } = {},
    onEvent?: (evt: SseEvent) => void,
  ): Promise<{ chatId: string }> {
    let res: Response;
    try {
      res = await fetch('/api/chat', {
        ...BASE,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          message,
          guest: opts.guest === true,
          ...(opts.fulfillment ? { fulfillment: opts.fulfillment } : {}),
          ...(opts.addressId ? { addressId: opts.addressId } : {}),
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      if (aborted) throw new ApiError('TIMEOUT', '已取消');
      throw new ApiError('NETWORK', '连接不上服务器');
    }

    if (!res.ok) {
      await unwrap<never>(res); // 抛 ApiError
    }
    if (!res.body) throw new ApiError('INTERNAL', '服务端没有返回内容');

    let chatId = '';
    let streamError: ApiError | null = null;

    await consumeSseStream(
      res.body,
      ({ event, data }) => {
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        if (event === 'stage') {
          const o = payload as { stage?: string; text?: string };
          onEvent?.({ type: 'stage', stage: (o.stage ?? 'intent') as StageName, text: o.text ?? '' });
        } else if (event === 'delta') {
          onEvent?.({ type: 'delta', text: (payload as { text?: string }).text ?? '' });
        } else if (event === 'reply') {
          /**
           * 契约注记：reply 事件的 data 直接就是 ChatReply，
           * 但后端历史版本曾包过一层 { payload }。两种都容忍。
           */
          const o = payload as Record<string, unknown>;
          const reply = (o.payload ?? o) as ChatReply;
          onEvent?.({ type: 'reply', payload: reply });
        } else if (event === 'done') {
          chatId = (payload as { chatId?: string }).chatId ?? '';
          onEvent?.({ type: 'done', chatId });
        } else if (event === 'error') {
          const o = payload as { error?: string; message?: string };
          const code = (o.error && ERROR_CODES.has(o.error) ? o.error : 'INTERNAL') as ErrorCode;
          streamError = new ApiError(code, o.message ?? '出错了');
          onEvent?.({ type: 'error', error: code, message: o.message ?? '出错了' });
        }
      },
      opts.signal,
    );

    if (streamError) throw streamError;
    return { chatId };
  },

  /* ---- 订单 ---- */
  confirmOrder: (chatId: string, opts: { addressId?: string } = {}) =>
    post<OrderInfo>('/api/orders/confirm', { chatId, ...(opts.addressId ? { addressId: opts.addressId } : {}) }),

  /**
   * 按**当前购物车**下单。
   *
   * 和 confirmOrder 的区别：那个用对话时的菜单快照，
   * 这个用购物车现在的状态。用户手动删了东西还按老菜单付钱是不能接受的。
   */
  confirmCart: (opts: { fulfillment?: Fulfillment; addressId?: string } = {}) =>
    post<OrderInfo>('/api/orders/confirm-cart', {
      ...(opts.fulfillment ? { fulfillment: opts.fulfillment } : {}),
      ...(opts.addressId ? { addressId: opts.addressId } : {}),
    }),
  getOrder: (orderId: string) => get<OrderInfo>(`/api/orders/${encodeURIComponent(orderId)}`),
  cancelOrder: (orderId: string) => del<{ ok: true }>(`/api/orders/${encodeURIComponent(orderId)}`),

  /* ---- 外送地址 ---- */
  getAddresses: () => get<AddressListResponse>('/api/orders/addresses'),
  createAddress: (input: CreateAddressRequest) => post<DeliveryAddress>('/api/orders/addresses', input),

  /* ---- 购物车 ---- */
  /**
   * 读购物车。外送场景服务端会实时算一次配送费 ——
   * 配送费随地址变化，用前端自己加会算错钱。
   */
  getCart: (opts: { fulfillment?: Fulfillment } = {}) =>
    get<Cart>(`/api/cart${qs({ fulfillment: opts.fulfillment })}`),

  addToCart: (
    input: {
      productId: string;
      qty?: number;
      spec?: string;
      selected?: string[];
      fulfillment?: Fulfillment;
      store?: string;
      storeCode?: string;
      beCode?: string;
    },
  ) => post<Cart>('/api/cart', input),

  updateCartItem: (
    id: string,
    body: { qty?: number; spec?: string; selected?: string[]; fulfillment?: Fulfillment },
  ) => patch<Cart>(`/api/cart/items/${encodeURIComponent(id)}`, body),

  removeCartItem: (id: string, opts: { fulfillment?: Fulfillment } = {}) =>
    del<Cart>(`/api/cart/items/${encodeURIComponent(id)}${qs({ fulfillment: opts.fulfillment })}`),

  clearCart: (opts: { fulfillment?: Fulfillment } = {}) =>
    del<Cart>(`/api/cart${qs({ fulfillment: opts.fulfillment })}`),

  searchProducts: (q: string, opts: { fulfillment?: Fulfillment } = {}) =>
    get<{ items: SearchProduct[] }>(`/api/cart/search${qs({ q, fulfillment: opts.fulfillment })}`),

  /* ---- 定位 ---- */
  submitLocation: (p: { lat: number; lng: number; city?: string; district?: string; source: 'gps' | 'manual' }) =>
    post<{ city?: string; district?: string; needCity?: boolean }>('/api/location', p),
  getLocation: () => get<LocationInfo>('/api/location'),
  clearLocation: () => del<{ ok: true }>('/api/location'),

  /* ---- 记忆 ---- */
  getMemory: () => get<MemoryResponse>('/api/memory'),
  deleteMemory: (key: string) => del<{ ok: true }>(`/api/memory/${encodeURIComponent(key)}`),

  /* ---- 菜单 / 券包（轻量版，聊天用） ---- */
  getMenu: (storeCode?: string) => get<MenuAll>(`/api/menu${qs({ storeCode })}`),
  getAssets: () => get<{ coupons: unknown[]; points?: number }>('/api/assets'),
  getStoreCoupons: (storeCode: string) => get<{ coupons: unknown[] }>(`/api/assets/store-coupons${qs({ storeCode })}`),
  claimCoupon: (couponId: string) => post<{ ok: true }>('/api/assets/claim', { couponId }),

  /* ---- Explorer：35 工具数据面 ---- */
  overview: () => get<OverviewResponse>('/api/explorer/overview'),
  stores: (p: { city?: string; keyword?: string; beType?: 1 | 5 } = {}) =>
    get<StoresResponse>(`/api/explorer/stores${qs({ city: p.city, keyword: p.keyword, beType: p.beType })}`),
  explorerMenu: (p: { storeCode?: string; beType?: 1 | 5 } = {}) =>
    get<MenuResponse>(`/api/explorer/menu${qs({ storeCode: p.storeCode, beType: p.beType })}`),
  mealDetail: (code: string, storeCode?: string) =>
    get<MealResponse>(`/api/explorer/meal/${encodeURIComponent(code)}${qs({ storeCode })}`),
  nutrition: (q?: string) => get<NutritionResponse>(`/api/explorer/nutrition${qs({ q })}`),
  coupons: () => get<CouponsResponse>('/api/explorer/coupons'),
  points: () => get<PointsResponse>('/api/explorer/points'),
  mall: (cat?: string) => get<MallResponse>(`/api/explorer/mall${qs({ cat })}`),
  mallDetail: (spuId: number | string) =>
    get<{ meta: BlockMetaLike; data: MallProductDetail | undefined }>(`/api/explorer/mall/${encodeURIComponent(String(spuId))}`),
  explorerOrders: () => get<OrdersResponse>('/api/explorer/orders'),
  orderDetail: (orderId: string, kind: 'food' | 'mall' = 'food') =>
    get<OrderDetailResponse>(`/api/explorer/order/${encodeURIComponent(orderId)}${qs({ kind })}`),
  campaigns: (date?: string) => get<CampaignsResponse>(`/api/explorer/campaigns${qs({ date })}`),
  parties: (spuId?: number) => get<PartiesResponse>(`/api/explorer/parties${qs({ spuId })}`),
  partyProducts: () => get<PartyProductsResponse>('/api/explorer/parties/products'),
  partyStores: (p: { code: string; spuId?: number; lat?: number; lng?: number }) =>
    get<PartyStoresResponse>(`/api/explorer/parties/stores${qs(p)}`),
  partyDates: (p: { storeCode: string; spuId: number }) =>
    get<PartyDatesResponse>(`/api/explorer/parties/dates${qs(p)}`),
  partySessions: (p: { storeCode: string; spuId: number; dateStr: string }) =>
    get<PartySessionsResponse>(`/api/explorer/parties/sessions${qs(p)}`),
  addresses: () => get<{ meta: BlockMetaLike; data: AddressCard[] }>('/api/explorer/addresses'),
  tools: () => get<ToolsResponse>('/api/explorer/tools'),
  callTool: (name: string, args: Record<string, unknown> = {}, confirm = false) =>
    post<ToolCallResult>(`/api/explorer/tools/${encodeURIComponent(name)}`, { args, ...(confirm ? { confirm: true } : {}) }),
  price: (p: { storeCode?: string; beType?: number; orderType?: number; items: Array<{ productCode: string; quantity: number }> }) =>
    post<{ meta: BlockMetaLike; data: PriceBreakdown | undefined; storeCode: string }>('/api/explorer/price', p),
};

/** 子集类型，避免循环 import */
type BlockMetaLike = import('./types').BlockMeta;

/* ------------------------------------------------------------------ */
/* 导出：mock 分支由 mock.ts 提供，真实实现始终可用                        */
/* ------------------------------------------------------------------ */

export type Api = typeof realApi;

export const api: Api = realApi;

/** 是否处于 mock 模式（组件里偶尔要据此调整文案） */
export const usingMock = MOCK;

/** 便于调试时拿到全部真实方法 */
export { realApi };

/* ---- 类型再导出，省得组件到处 import ---- */
export type {
  AccountInfo,
  CampaignDay,
  ChatReply,
  CouponCard,
  MallProduct,
  MealDetail,
  MemoryCard,
  MenuCard,
  NutritionRow,
  OrderCard,
  OverviewResponse,
  StoreCard,
  ToolCallResult,
  ToolMeta,
  ToolsResponse,
} from './types';
