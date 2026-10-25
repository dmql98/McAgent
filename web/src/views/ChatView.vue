<script setup lang="ts">
/**
 * 对话点餐
 *
 * 产品主链路，保留旧版的全部行为：
 *   · SSE 三阶段（stage / delta / reply）
 *   · 打字机效果（delta 是 hook 的前缀，逐字追加）
 *   · 建单确认条（默认不自动下单）
 *   · 支付卡片 + 状态轮询（3s → 10s，上限 5 分钟，切后台暂停）
 *   · 访客限额引导
 *   · 流内错误气泡（不用 alert）
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { store } from '../store';
import { ApiError, messageOf } from '../lib/error';
import { money, parseHook } from '../lib/format';
import { toast } from '../lib/toast';
import CartPanel from '../components/CartPanel.vue';
import AppIcon from '../components/AppIcon.vue';
import type { Cart, ChatReply, DeliveryAddress, Fulfillment, OrderInfo } from '../types';

const router = useRouter();
const ORDER_STATUS_TEXT: Record<OrderInfo['status'], string> = {
  created: '待付款',
  paid: '已付款',
  progress: '处理中',
  done: '已完成',
  canceled: '已取消',
};

interface ReplyBlock {
  kind: 'reply';
  reply: ChatReply;
  /** 建单确认条是否展开 */
  confirmOpen: boolean;
  /** 冲突提示文案 */
  conflict: string;
  order: OrderInfo | null;
  orderStatus: string;
  orderStatusKind: '' | 'ok' | 'bad';
  paying: boolean;
  ordering: boolean;
}

interface UserBlock {
  kind: 'user';
  text: string;
}

interface ErrorBlock {
  kind: 'error';
  message: string;
  code: string;
}

interface UpsellBlock {
  kind: 'upsell';
  message: string;
}

type Block = UserBlock | ReplyBlock | ErrorBlock | UpsellBlock;

const blocks = ref<Block[]>([]);
const input = ref('');
const sending = ref(false);
const chatEl = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

/* ------------------------------------------------------------------ */
/* 购物车                                                             */
/* ------------------------------------------------------------------ */

/**
 * 购物车从"聊天气泡里的只读卡片"独立出来了。
 *
 * 为什么要独立：气泡里的菜单只能看不能改，用户想吃掉一份薯条
 * 只能重新问一遍，而重新问必然整单重配 —— 越改越乱。
 * 现在左边聊天、右边购物车：对话负责"配一单"，购物车负责"改这一单"。
 */
const cartRef = ref<{ reload: () => Promise<void> } | null>(null);
/** 窄屏抽屉开关；宽屏下购物车常驻，这个值不影响布局 */
const cartOpen = ref(false);
/** 侧栏要显示的件数与合计，来自 CartPanel 的回传 */
const cartCount = ref(0);
const cartTotal = ref(0);
/** 门店名：从最近一次对话回复里取，让用户知道这是哪家店 */
const cartStore = ref('');

function onCartChange(cart: Cart): void {
  cartCount.value = cart.count;
  cartTotal.value = cart.total;
  if (cart.store) cartStore.value = cart.store;
}

function openCart(): void {
  cartOpen.value = true;
  void cartRef.value?.reload();
}

/**
 * 从购物车去下单。
 *
 * 必须走 confirm-cart（按购物车当前状态结算），
 * 不能走 confirm（那个用的是对话时的菜单快照）。
 * 用户手动删了薯条再点"去下单"，按原菜单收钱是不能接受的。
 */
const cartOrdering = ref(false);
async function onCartCheckout(cart: Cart): Promise<void> {
  if (cart.items.length === 0 || cartOrdering.value) return;
  if (fulfillment.value === '外送' && !addressId.value) {
    toast('先选一个配送地址', true);
    return;
  }
  cartOrdering.value = true;
  try {
    const order = await api.confirmCart({
      fulfillment: fulfillment.value,
      ...(fulfillment.value === '外送' && addressId.value ? { addressId: addressId.value } : {}),
    });
    // 下单成功：在聊天里给一张支付卡
    const block: ReplyBlock = {
      kind: 'reply',
      reply: {
        hook: '订单建好了，去付款吧。',
        meta: { store: order.store ?? cart.store ?? '', slot: '', title: '购物车' },
        menu: [],
        total: order.total,
        quote: '请完成付款，并留意订单进度。',
        actions: [],
        dataSource: 'mcp',
      },
      confirmOpen: false,
      conflict: '',
      order,
      orderStatus: '',
      orderStatusKind: '',
      paying: false,
      ordering: false,
    };
    blocks.value.push(block);
    scrollChat();
    void cartRef.value?.reload();
    startPolling(block);
  } catch (e) {
    toast(messageOf(e) || '下单失败，请稍后重试', true);
  } finally {
    cartOrdering.value = false;
  }
}

/**
 * 履约方式：**开局就要定**。
 *
 * 为什么不能在下单时再切：到店和外送是两套商品编码
 * （实测同一门店 90 个到店商品里 77 个外送不存在），
 * 菜单按哪套查的，就只能按哪套下单。中途切换必然建单失败。
 * 所以这里做成对话开始前的选择，定了就不让改（要改就重开一个对话）。
 */
const fulfillment = ref<Fulfillment>('自取');
/**
 * 对话一旦开始就不让改履约方式：
 * 菜单是按当时那套场景查的，改了必然对不上商品编码。
 * 要换方式 → 开一个新对话。
 */
const fulfillmentLocked = computed(() => blocks.value.length > 0);

/* ---- 外送地址 ---- */
const addresses = ref<DeliveryAddress[]>([]);
const addressId = ref('');
const addrLoading = ref(false);
const addrError = ref('');

/** 新建地址表单（内联展开，不弹模态框，少一层打断） */
const addrFormOpen = ref(false);
const addrForm = reactive({
  city: '',
  contactName: '',
  phone: '',
  gender: '先生',
  address: '',
  addressDetail: '',
});
const addrSaving = ref(false);

const currentAddress = computed(() => addresses.value.find((a) => a.addressId === addressId.value));

/** 外送必须有地址才能发消息 */
const canSend = computed(() => {
  if (!input.value.trim() || sending.value) return false;
  if (fulfillment.value === '外送' && !addressId.value) return false;
  return true;
});

async function loadAddresses() {
  if (addrLoading.value) return;
  addrLoading.value = true;
  addrError.value = '';
  try {
    const res = await api.getAddresses();
    addresses.value = res.addresses;
    if (!addressId.value) {
      addressId.value = res.defaultId ?? res.addresses[0]?.addressId ?? '';
    }
    if (res.addresses.length === 0) {
      addrFormOpen.value = true;
    }
  } catch (e) {
    addrError.value = messageOf(e) || '地址没加载出来';
  } finally {
    addrLoading.value = false;
  }
}

async function saveAddress() {
  if (addrSaving.value) return;
  const f = addrForm;
  if (!f.city.trim() || !f.contactName.trim() || !f.address.trim() || !f.addressDetail.trim()) {
    toast('城市、联系人、地址、门牌号都要填', true);
    return;
  }
  if (!/^1\d{10}$/.test(f.phone.trim())) {
    toast('手机号要 11 位纯数字', true);
    return;
  }

  addrSaving.value = true;
  try {
    const created = await api.createAddress({
      city: f.city.trim(),
      contactName: f.contactName.trim(),
      gender: f.gender,
      phone: f.phone.trim(),
      address: f.address.trim(),
      addressDetail: f.addressDetail.trim(),
    });
    await loadAddresses();
    addressId.value = created.addressId;
    addrFormOpen.value = false;
    toast('地址加好了');
  } catch (e) {
    toast(messageOf(e) || '地址没保存成功', true);
  } finally {
    addrSaving.value = false;
  }
}

/** 切到外送时立刻拉地址；切回到店不需要 */
watch(fulfillment, (v) => {
  if (v === '外送' && !store.state.guest) void loadAddresses();
});

/** 打字机：当前正在成形的文本 */
const typingText = ref('');
const typing = computed(() => typingText.value.length > 0);

/** 进度文案（stage 事件） */
const stageText = ref('');

/** 场景快捷输入 */
const SCENES = [
  { s: 'mood', label: '一人午餐 30 元', text: '一个人吃午餐，预算30元，想要汉堡和无糖饮料' },
  { s: 'budget', label: '4 人 150 元', text: '明天中午4个人，预算150元，有人不吃辣' },
  { s: 'returning', label: '两人份，不吃辣', text: '帮我选两人份晚餐，不吃辣，饮料选热的' },
];

let typeQueue: Promise<void> = Promise.resolve();

/* ---------------- 滚动 ---------------- */

function scrollChat() {
  void nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/* ---------------- 发送 ---------------- */

async function send(text?: string) {
  const msg = (text ?? input.value).trim();
  if (!msg || sending.value) return;

  /**
   * 外送没有地址就不发请求 —— 后端会回 NEED_ADDRESS，
   * 但让用户白等一轮更糟，这里直接拦住。
   */
  if (fulfillment.value === '外送' && !addressId.value) {
    toast('先选一个配送地址，或者新建一个', true);
    addrFormOpen.value = addresses.value.length === 0;
    return;
  }

  input.value = '';
  sending.value = true;
  typingText.value = '';
  stageText.value = '正在查询餐品…';
  store.raw.lastUserText = msg;

  blocks.value.push({ kind: 'user', text: msg });
  scrollChat();

  let pendingReply: ChatReply | null = null;
  let chatId = '';

  try {
    await api.chat(
      msg,
      {
        guest: store.state.guest,
        fulfillment: fulfillment.value,
        ...(fulfillment.value === '外送' && addressId.value ? { addressId: addressId.value } : {}),
      },
      (evt) => {
      switch (evt.type) {
        case 'stage':
          stageText.value = evt.text;
          break;
        case 'delta':
          // delta 是 hook 的前缀，逐字追加到打字机
          typeInto(evt.text);
          break;
        case 'reply':
          pendingReply = evt.payload;
          break;
        case 'done':
          chatId = evt.chatId;
          break;
        case 'error':
          stageText.value = '';
          blocks.value.push({ kind: 'error', message: evt.message, code: evt.error });
          // 后端说没地址 → 顺手把地址区打开，别让用户自己找
          if (evt.error === 'NEED_ADDRESS') {
            void loadAddresses();
            addrFormOpen.value = addresses.value.length === 0;
          }
          scrollChat();
          break;
      }
      },
    );

    // 等打字机放完再整体渲染，避免文字跳变
    await typeQueue;
    stageText.value = '';

    if (pendingReply) {
      const reply: ChatReply = pendingReply;
      blocks.value.push({
        kind: 'reply',
        reply,
        confirmOpen: false,
        conflict: '',
        order: null,
        orderStatus: '',
        orderStatusKind: '',
        paying: false,
        ordering: false,
      });
      typingText.value = '';
      scrollChat();

      /**
       * 刷新购物车。
       *
       * 两种可能：
       *   · 这一轮是正常选品 → 后端已经把菜单写进购物车（替换式），这里读回来显示；
       *   · 这一轮是"改购物车"指令 → 后端已经改完，这里读回来同步数量。
       * 统一读一次，前端不用区分，也不会出现"左边说改了、右边没变"。
       *
       * 但只有**带菜单**的回复才自动打开购物车：
       * 用户只是删了一项，不该把侧栏弹出来抢注意力。
       */
      if (reply.menu.length > 0) cartOpen.value = true;
      void cartRef.value?.reload();
    }
    if (chatId) store.raw.lastChatId = chatId;
    void store.refreshMemory(true);
  } catch (e) {
    stageText.value = '';
    typingText.value = '';
    if (e instanceof ApiError && e.code === 'GUEST_LIMIT_REACHED') {
      blocks.value.push({
        kind: 'upsell',
        message: '今天的访客体验次数已用完，登录后可继续点餐。',
      });
    } else if (e instanceof ApiError) {
      blocks.value.push({ kind: 'error', message: e.message, code: e.code });
    } else {
      blocks.value.push({ kind: 'error', message: messageOf(e), code: 'INTERNAL' });
    }
    scrollChat();
  } finally {
    sending.value = false;
    scrollChat();
  }
}

function typeInto(chunk: string) {
  typeQueue = typeQueue.then(async () => {
    for (const ch of chunk) {
      typingText.value += ch;
      const el = scroller.value;
      if (el) el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 24));
    }
  });
}

/* ---------------- 建单 ---------------- */

async function askConfirm(b: ReplyBlock) {
  if (!store.raw.lastChatId) {
    toast('这条回复没有可下单的菜单', true);
    return;
  }
  if (store.state.guest) {
    blocks.value.push({ kind: 'upsell', message: '下单需先登录麦当劳账号。' });
    scrollChat();
    return;
  }
  b.confirmOpen = true;
  scrollChat();
}

async function doOrder(b: ReplyBlock) {
  if (b.ordering) return;
  b.ordering = true;
  b.confirmOpen = false;
  try {
    /**
     * 只带一个 addressId，履约方式不传 ——
     * 由服务端沿用对话落库的那个，避免"菜单按外送选、却按到店下单"。
     */
    const order = await api.confirmOrder(store.raw.lastChatId, {
      ...(addressId.value ? { addressId: addressId.value } : {}),
    });
    b.order = order;
    b.orderStatus = '订单已创建，等你付款';
    b.orderStatusKind = '';
    startPolling(b);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'ORDER_CONFLICT') {
      b.conflict = e.message;
    } else if (e instanceof ApiError && (e.code === 'TOKEN_INVALID' || e.code === 'UNAUTHORIZED')) {
      blocks.value.push({ kind: 'error', message: e.message, code: e.code });
    } else {
      toast(messageOf(e) || '下单失败，请重试', true);
    }
  } finally {
    b.ordering = false;
  }
}

/* ---------------- 支付状态轮询 ---------------- */

let pollTimer = 0;
let pollStopped = true;

function stopPolling() {
  pollStopped = true;
  clearTimeout(pollTimer);
}

function startPolling(b: ReplyBlock) {
  stopPolling();
  pollStopped = false;

  const startedAt = Date.now();
  const MAX_MS = 5 * 60 * 1000;
  const FAST_MS = 3000;
  const SLOW_MS = 10_000;
  const FAST_UNTIL = 30_000;

  const schedule = () => {
    if (pollStopped) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed > MAX_MS) {
      b.orderStatus = '尚未收到付款，可稍后在订单记录中查看';
      stopPolling();
      return;
    }
    pollTimer = window.setTimeout(tick, elapsed < FAST_UNTIL ? FAST_MS : SLOW_MS);
  };

  const tick = async () => {
    if (pollStopped || !b.order) return;

    // 页面在后台就跳过这一轮，不烧请求
    if (document.hidden) {
      schedule();
      return;
    }

    try {
      const s = await api.getOrder(b.order.orderId);
      if (pollStopped) return;
      b.orderStatus = s.progressText || ORDER_STATUS_TEXT[s.status];
      b.orderStatusKind = s.status === 'done' ? 'ok' : s.status === 'canceled' ? 'bad' : '';
      if (s.status === 'done') {
        stopPolling();
        void store.refreshMemory(true);
        return;
      }
      if (s.status === 'canceled') {
        stopPolling();
        return;
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'UNAUTHORIZED' || e.code === 'TOKEN_INVALID')) {
        b.orderStatus = e.message;
        b.orderStatusKind = 'bad';
        stopPolling();
        return;
      }
      if (e instanceof ApiError && e.code === 'NOT_FOUND') {
        b.orderStatus = '查不到这个订单了';
        b.orderStatusKind = 'bad';
        stopPolling();
        return;
      }
    }
    schedule();
  };

  schedule();
}

/** 切回前台立刻补一次，不必干等 10 秒 */
function onVisible() {
  if (!document.hidden && !pollStopped) {
    clearTimeout(pollTimer);
    // 下一轮 tick 由 schedule 里的闭包持有，这里只是提前触发
    pollTimer = window.setTimeout(() => {
      const last = blocks.value.filter((x): x is ReplyBlock => x.kind === 'reply').pop();
      if (last?.order) void api.getOrder(last.order.orderId).then((s) => {
        last.orderStatus = s.progressText || ORDER_STATUS_TEXT[s.status];
        last.orderStatusKind = s.status === 'done' ? 'ok' : s.status === 'canceled' ? 'bad' : '';
      }).catch(() => undefined);
    }, 60);
  }
}

document.addEventListener('visibilitychange', onVisible);
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisible);
  stopPolling();
});

/* ---------------- 辅助 ---------------- */

function pay(b: ReplyBlock) {
  if (!b.order?.payUrl) return;
  window.open(b.order.payUrl, '_blank', 'noopener');
}

function retryWithNewPrice(b: ReplyBlock) {
  b.conflict = '';
  void doOrder(b);
}

function relogin() {
  void router.push({ name: 'login' });
}

function fillRefine() {
  input.value = '换一批，别重复刚才的';
}

/** 重开对话：清空消息，回到开局选择态 */
function resetChat() {
  if (sending.value) return;
  stopPolling();
  blocks.value = [];
  input.value = '';
  typingText.value = '';
  stageText.value = '';
  store.raw.lastChatId = '';
  scrollChat();
}

// 恢复上次对话时保持滚动到底
watch(blocks, scrollChat, { deep: false });
</script>

<template>
  <div class="chat-layout">
    <!-- 窄屏：购物车抽屉的遮罩 -->
    <div v-if="cartOpen" class="cart-mask" @click="cartOpen = false" />

    <!-- 左：对话 -->
    <div class="chat-wrap">
      <div ref="chatEl" class="chat-scroll">
        <div ref="scroller" class="chat-inner">
        <!-- 空态 -->
        <div v-if="blocks.length === 0 && !typing" class="chat-empty">
          <div class="empty-logo">M</div>

          <!-- 开局第一件事：选到店还是外送 -->
          <div class="fulfil-pick">
            <p class="fulfil-title">这单怎么吃？</p>
            <div class="fulfil-opts">
              <button
                class="fulfil-opt"
                :class="{ on: fulfillment === '自取' }"
                type="button"
                @click="fulfillment = '自取'"
              >
                <span class="fo-icon"><AppIcon name="bag" :size="20" /></span>
                <span class="fo-main">到店自取</span>
                <span class="fo-sub">到店现做，自己去拿</span>
              </button>
              <button
                class="fulfil-opt"
                :class="{ on: fulfillment === '外送' }"
                type="button"
                @click="fulfillment = '外送'"
              >
                <span class="fo-icon"><AppIcon name="scooter" :size="21" /></span>
                <span class="fo-main">麦乐送</span>
                <span class="fo-sub">送到你手上，有配送费</span>
              </button>
            </div>
            <p v-if="fulfillment === '外送'" class="fulfil-note">
              {{ currentAddress ? `送到：${currentAddress.fullAddress}` : '还没选地址 —— 在下面输入框上方选一个' }}
            </p>
          </div>

          <h2>今天想吃什么？</h2>
          <p class="empty-tip">
            告诉我人数、预算和口味偏好，我来推荐。<br />
            也可以直接说餐品名称，比如「巨无霸套餐」。
          </p>
          <div class="chips empty-chips">
            <span class="chips-label">试试这样问</span>
            <button v-for="s in SCENES" :key="s.s" class="chip" type="button" @click="send(s.text)">
              {{ s.label }}
            </button>
          </div>
        </div>

        <!-- 消息流 -->
        <template v-for="(b, i) in blocks" :key="i">
          <!-- 用户 -->
          <div v-if="b.kind === 'user'" class="bubble user">{{ b.text }}</div>

          <!-- 打字机 -->
          <div v-else-if="false" />

          <!-- 错误 -->
          <div v-else-if="b.kind === 'error'" class="bubble ai err">
            <div class="ai-head"><span class="dot" />暂时没能完成</div>
            <p>{{ b.message }}</p>
            <div v-if="b.code === 'TOKEN_INVALID' || b.code === 'UNAUTHORIZED'" class="actions">
              <button class="btn-act btn-primary" type="button" @click="relogin">重新登录</button>
            </div>
            <div v-else-if="b.code === 'NEED_LOCATION'" class="actions">
              <router-link class="btn-act btn-primary" to="/memory">去设置定位</router-link>
            </div>
            <div v-else-if="b.code === 'NEED_ADDRESS'" class="actions">
              <button class="btn-act btn-primary" type="button" @click="addrFormOpen = true">填一个配送地址</button>
            </div>
          </div>

          <!-- 访客引导 -->
          <div v-else-if="b.kind === 'upsell'" class="bubble ai">
            <div class="ai-head"><span class="dot" />登录后可以继续</div>
            <p>{{ b.message }}</p>
            <div class="actions">
              <button class="btn-act btn-primary" type="button" @click="relogin">连接麦当劳账户</button>
            </div>
          </div>

          <!-- 正式回复 -->
          <div v-else class="bubble ai">
            <div class="ai-head"><span class="dot" />为你配餐</div>

            <p class="hook-body">
              <template v-for="(p, k) in parseHook(b.reply.hook)" :key="k">
                <span v-if="p.hook" class="hook">{{ p.text }}</span>
                <template v-else>{{ p.text }}</template>
              </template>
            </p>

            <!-- 数据来源 -->
            <div v-if="b.reply.dataSource === 'offline'" class="offline-note">参考菜单，价格以门店为准</div>

            <!--
              菜单摘要，不是明细。
              明细在右侧购物车里（可删可改数量），这里再列一遍就是重复。
              但也不能完全没有 —— 用户得知道"这一轮给我配了什么、多少钱"。
            -->
            <template v-if="b.reply.menu.length">
              <div v-if="b.reply.meta.title || b.reply.meta.store" class="divider">
                {{ [b.reply.meta.title, b.reply.meta.store].filter(Boolean).join(' · ') }}
              </div>
              <div class="menu-summary">
                <div class="ms-head">
                  <span class="ms-count">
                    已选 {{ b.reply.menu.length }} 件
                    <template v-if="b.reply.original && b.reply.original > b.reply.total">
                      · 券后 <b>{{ money(b.reply.total) }}</b>
                    </template>
                    <template v-else> · 合计 <b>{{ money(b.reply.total) }}</b></template>
                  </span>
                  <button class="ms-link" type="button" @click="openCart">查看购物车</button>
                </div>
                <div class="ms-list">
                  <span v-for="(m, k) in b.reply.menu" :key="k" class="ms-chip">
                    {{ m.name }}<i v-if="m.spec">{{ m.spec }}</i>
                  </span>
                </div>
                <div v-if="b.reply.budget" class="ms-budget">
                  <template v-if="b.reply.budget.ok">
                    预算 ¥{{ b.reply.budget.limit.toFixed(0) }} · 还剩 ¥{{ b.reply.budget.remaining.toFixed(1) }}
                  </template>
                  <template v-else>超出预算 ¥{{ Math.max(0, b.reply.total - b.reply.budget.limit).toFixed(1) }}</template>
                  <span v-if="b.reply.nutrition"> · {{ b.reply.nutrition }}</span>
                </div>
                <div v-else-if="b.reply.nutrition" class="ms-budget">{{ b.reply.nutrition }}</div>
              </div>

              <!-- 外送：费用明细 + 送达地址 -->
              <div v-if="b.reply.deliveryFee || b.reply.address" class="delivery-note">
                <div v-if="b.reply.deliveryFee" class="dn-fee">
                  含配送费 ¥{{ b.reply.deliveryFee.delivery.toFixed(1) }}
                  <template v-if="b.reply.deliveryFee.packing > 0">
                    ＋打包费 ¥{{ b.reply.deliveryFee.packing.toFixed(1) }}
                  </template>
                  <template v-if="b.reply.deliveryFee.minOrder">
                    · 起送 ¥{{ b.reply.deliveryFee.minOrder.toFixed(1) }}
                  </template>
                </div>
                <div v-if="b.reply.address" class="dn-addr">送到：{{ b.reply.address }}</div>
              </div>
            </template>

            <!-- 金句 -->
            <div v-if="b.reply.quote" class="quote">“{{ b.reply.quote }}”</div>

            <!-- 操作 -->
            <div v-if="b.reply.actions.length" class="actions">
              <template v-for="a in b.reply.actions" :key="a">
                <button
                  v-if="a === 'confirm'"
                  class="btn-act btn-primary"
                  type="button"
                  :disabled="b.ordering"
                  @click="askConfirm(b)"
                >
                  {{ b.ordering ? '正在下单…' : '确认下单' }}
                </button>
                <button v-else-if="a === 'reorder'" class="btn-act btn-primary" type="button" @click="askConfirm(b)">
                  再来一单
                </button>
                <button v-else-if="a === 'refine'" class="btn-act btn-ghost" type="button" @click="fillRefine">
                  换一换
                </button>
              </template>
            </div>

            <!-- 建单确认条 -->
            <div v-if="b.confirmOpen" class="confirm-bar">
              <div class="confirm-text">
                「{{ b.reply.meta.title || '这份菜单' }}」<b>{{ money(b.reply.total) }}</b> ·
                {{ b.reply.meta.store || '' }} · {{ b.reply.meta.fulfillment || '自取' }}，确认下单？
                <template v-if="b.reply.address"><br />送到：{{ b.reply.address }}</template>
              </div>
              <div class="confirm-acts">
                <button class="btn-act btn-primary" type="button" @click="doOrder(b)">确认</button>
                <button class="btn-act btn-ghost" type="button" @click="b.confirmOpen = false">再想想</button>
              </div>
            </div>

            <!-- 价格冲突 -->
            <div v-if="b.conflict" class="confirm-bar warn">
              <div class="confirm-text">{{ b.conflict }}</div>
              <div class="confirm-acts">
                <button class="btn-act btn-primary" type="button" @click="retryWithNewPrice(b)">按新价下单</button>
                <button class="btn-act btn-ghost" type="button" @click="b.conflict = ''">算了</button>
              </div>
            </div>

            <!-- 支付卡片 -->
            <div v-if="b.order" class="pay-card">
              <div class="pay-title">订单已创建 · 共 {{ money(b.order.total) }}</div>
              <div class="pay-row">
                <span>{{ b.order.store || '' }} · {{ b.reply.meta.fulfillment || '自取' }}</span>
                <span v-if="b.order.reused" class="pay-note" style="margin: 0 0 0 auto">已有待付款订单</span>
              </div>
              <div class="pay-note">订单号 {{ b.order.orderId }}</div>
              <div class="pay-foot">
                <button v-if="b.order.payUrl" class="btn-act btn-primary" type="button" @click="pay(b)">
                  点击去付款（扫码/链接）
                </button>
                <span v-else class="pay-note" style="margin: 0">订单已创建，但没拿到付款链接，去麦当劳 App 里查看</span>
              </div>
              <p class="pay-status" :class="b.orderStatusKind">{{ b.orderStatus }}</p>
              <p v-if="b.orderStatusKind === 'ok'" class="pay-done">订单已完成</p>
              <p class="pay-safe">请自行完成付款，并在订单记录中查看进度。</p>
            </div>

            <!-- 访客常驻提示 -->
            <div v-if="b.reply.upsell === 'login' || store.state.guest" class="upsell">
              <b>访客模式</b>
              登录后可保存用餐偏好、使用优惠券并下单。
              <div><button type="button" @click="relogin">连接麦当劳账户</button></div>
            </div>
          </div>
        </template>

        <!-- 进度 / 打字机 -->
        <div v-if="sending || typing" class="bubble ai">
          <div class="ai-head"><span class="dot" />正在配餐</div>
          <div v-if="!typing" class="typing">
            <i /><i /><i />
          </div>
          <p v-if="typing" class="hook-body typing-text">{{ typingText }}</p>
          <p v-if="stageText && !typing" class="stage-text">{{ stageText }}</p>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="composer">
      <!-- 对话已开始：履约方式锁定，给一个明确的提示 + 重开入口 -->
      <div v-if="fulfillmentLocked" class="fulfil-lock">
        <span class="fl-badge">{{ fulfillment === '外送' ? '麦乐送' : '到店自取' }}</span>
        <span class="fl-text">本对话已按这个方式选好菜单，换方式请重开一个对话</span>
        <button class="link-btn" type="button" @click="resetChat">重开对话</button>
      </div>

      <!-- 外送地址条（常驻，任何时候都能换地址/新建） -->
      <div v-if="fulfillment === '外送'" class="addr-bar">
        <div class="addr-bar-head">
          <span class="ab-label"><AppIcon name="scooter" :size="13" /> 送到</span>
          <button
            v-if="!addrFormOpen"
            class="link-btn"
            type="button"
            @click="addrFormOpen = true"
          >
            {{ addresses.length === 0 ? '+ 填地址' : '改地址 / 新建' }}
          </button>
          <button v-else class="link-btn" type="button" @click="addrFormOpen = false">收起</button>
        </div>

        <div v-if="store.state.guest" class="addr-hint">登录后可查看配送地址并使用外送服务。</div>

        <template v-else>
          <div v-if="addrLoading" class="addr-hint">正在读你的配送地址…</div>
          <div v-else-if="addrError" class="addr-hint err">
            {{ addrError }}
            <button class="link-btn" type="button" @click="loadAddresses">重试</button>
          </div>

          <!-- 已存地址：横向单选 -->
          <div v-else-if="addresses.length" class="addr-chips">
            <label
              v-for="a in addresses"
              :key="a.addressId"
              class="addr-chip"
              :class="{ on: a.addressId === addressId }"
            >
              <input v-model="addressId" type="radio" :value="a.addressId" />
              <span class="ac-tag" v-if="a.isDefault">默认</span>
              <span class="ac-text">
                <b>{{ a.contactName }}</b> {{ a.fullAddress }}
              </span>
            </label>
          </div>
          <div v-else-if="!addrFormOpen" class="addr-hint">
            还没有配送地址，点右边「填地址」加一个。
          </div>

          <!-- 新建表单 -->
          <div v-if="addrFormOpen" class="addr-form">
            <div class="af-row">
              <input v-model="addrForm.city" class="af-input" placeholder="城市（如 厦门市）" />
              <input v-model="addrForm.contactName" class="af-input" placeholder="联系人" />
            </div>
            <div class="af-row">
              <input v-model="addrForm.phone" class="af-input" maxlength="11" placeholder="手机号（11 位）" />
              <select v-model="addrForm.gender" class="af-input">
                <option value="先生">先生</option>
                <option value="女士">女士</option>
              </select>
            </div>
            <div class="af-row">
              <input v-model="addrForm.address" class="af-input" placeholder="地址（如 清竹园9号楼）" />
            </div>
            <div class="af-row">
              <input v-model="addrForm.addressDetail" class="af-input" placeholder="门牌号（如 2单元508）" />
            </div>
            <div class="af-acts">
              <button class="btn-act btn-primary" type="button" :disabled="addrSaving" @click="saveAddress">
                {{ addrSaving ? '保存中…' : '保存地址' }}
              </button>
            </div>
            <p class="af-note">地址将保存至你的麦当劳账号。</p>
          </div>
        </template>
      </div>

      <div class="composer-inner">
        <input
          v-model="input"
          class="composer-input"
          type="text"
          autocomplete="off"
          :disabled="sending"
          :placeholder="
            fulfillment === '外送' && !addressId
              ? '先选一个配送地址…'
              : '例如：两个人，预算80元，不吃辣'
          "
          @keydown.enter.prevent="send()"
        />
        <button class="btn-send" type="button" :disabled="!canSend" @click="send()">发送</button>
      </div>
      <p class="composer-note">
        <template v-if="store.state.guest">访客模式 · 每天 1 次点餐体验 · 下单需登录</template>
        <template v-else>
          {{ fulfillment === '外送' ? '麦乐送 · 实付已含配送费与打包费' : '到店自取 · 菜单与价格来自麦当劳实时数据' }}
          · 付款由你自己完成
        </template>
      </p>
    </div>
    </div>

    <!-- 右：购物车 -->
    <div class="cart-slot" :class="{ open: cartOpen }">
      <CartPanel
        ref="cartRef"
        :fulfillment="fulfillment"
        :readonly="store.state.guest"
        :store="cartStore"
        @change="onCartChange"
        @checkout="onCartCheckout"
        @close="cartOpen = false"
      />
    </div>

    <!-- 窄屏：悬浮的购物车入口 -->
    <button v-if="cartCount > 0" class="cart-fab" type="button" @click="cartOpen = true">
      <AppIcon name="bag" :size="15" /> {{ cartCount }} 件 · {{ money(cartTotal) }}
    </button>
  </div>
</template>

<style scoped>
/* ---------------- 左右布局：左聊天 / 右购物车 ---------------- */

/*
 * 注意：这个根节点同时被 App.vue 追加了全局类 page-chat，
 * 而 layout.css 里的 .page-chat 声明了 flex-direction: column。
 * 两者叠加会把「左聊天 / 右购物车」压成上下堆叠，聊天区高度塌成 0。
 * 所以这里必须显式把方向钉回 row，不能只依赖 display:flex。
 */
.chat-layout {
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 14px;
  padding: 14px;
  box-sizing: border-box;
  overflow: hidden;
}

.chat-wrap {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  height: 100%;
  /* 纵向：滚动区吃满剩余高度，输入区钉在底部 */
  display: flex;
  flex-direction: column;
  /* 聊天区单独一张卡，和右边购物车视觉上分开 */
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.cart-slot {
  width: 320px;
  flex: 0 0 320px;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 窄屏时购物车变成右侧抽屉 */
.cart-mask {
  display: none;
}

.cart-fab {
  display: none;
}

@media (max-width: 1100px) {
  .chat-layout {
    padding: 0;
    gap: 0;
  }
  .chat-wrap {
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
  /* 抽屉：默认藏在屏幕外，加 .open 滑出来 */
  .cart-slot {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(340px, 86vw);
    z-index: 60;
    padding: 10px;
    box-sizing: border-box;
    transform: translateX(102%);
    transition: transform 0.22s ease;
  }
  .cart-slot.open {
    transform: translateX(0);
  }
  .cart-mask {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(43, 33, 24, 0.32);
    z-index: 55;
  }
  /* 有东西时，底部浮一个入口，随时能看到几件多少钱 */
  .cart-fab {
    display: flex;
    align-items: center;
    gap: 6px;
    position: fixed;
    right: 16px;
    bottom: 92px;
    z-index: 50;
    padding: 10px 16px;
    border: none;
    border-radius: 22px;
    background: var(--red);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(218, 41, 28, 0.32);
  }
}

.chat-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.chat-inner {
  max-width: 780px;
  margin: 0 auto;
  padding: 22px 20px 12px;
}

.chat-empty {
  text-align: center;
  padding: 44px 20px 40px;
  color: var(--ink-2);
  font-size: 13.5px;
  line-height: 1.85;
}
.chat-empty h2 {
  font-size: 21px;
  font-weight: 900;
  color: var(--ink);
  letter-spacing: -0.3px;
  margin: 18px 0 6px;
}
.empty-logo {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--yellow);
  color: var(--red);
  border: 3px solid var(--red);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 900;
  margin: 0 auto 4px;
  opacity: 0.92;
}

/* ---- 气泡 ---- */
.bubble {
  max-width: 86%;
  margin-bottom: 14px;
  animation: pop 0.3s ease both;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.bubble.user {
  margin-left: auto;
  background: var(--yellow);
  border-radius: 16px 16px 4px 16px;
  padding: 11px 16px;
  font-size: 14px;
  font-weight: 600;
  box-shadow: var(--shadow-sm);
  width: fit-content;
}
.bubble.ai {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 4px solid var(--red);
  border-radius: 16px 16px 16px 4px;
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
}
.bubble.ai.err {
  border-left-color: var(--red);
  background: #FFF8F7;
}
.bubble.ai.err p {
  color: var(--red-dark);
  margin-bottom: 4px;
}

.ai-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.ai-head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--red);
}

.hook-body {
  font-size: 14px;
  line-height: 1.75;
  margin: 7px 0;
}
.hook {
  color: var(--red-dark);
  font-weight: 700;
}
.typing-text {
  white-space: pre-wrap;
}

.divider {
  font-size: 11.5px;
  color: var(--ink-2);
  letter-spacing: 1.5px;
  margin: 14px 0 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* ---------------- 菜单摘要（明细在右侧购物车） ---------------- */

.menu-summary {
  background: #fffdf8;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 12px;
  margin: 10px 0;
}
.ms-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.ms-count {
  font-size: 12.5px;
  color: var(--ink-2);
}
.ms-count b {
  color: var(--red);
  font-size: 15px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.ms-link {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--red);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 2px 0;
  white-space: nowrap;
}
.ms-link:hover {
  text-decoration: underline;
}
.ms-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.ms-chip {
  font-size: 11.5px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 3px 9px;
  line-height: 1.5;
}
.ms-chip i {
  font-style: normal;
  color: var(--ink-3);
  margin-left: 3px;
  font-size: 11px;
}
.ms-budget {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed var(--line);
  font-size: 11.5px;
  color: var(--ink-3);
}

.quote {
  border-left: 3px solid var(--yellow);
  background: var(--yellow-soft);
  border-radius: 0 10px 10px 0;
  padding: 10px 14px;
  font-size: 13px;
  font-style: italic;
  margin-top: 10px;
  line-height: 1.7;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.btn-act {
  border-radius: 10px;
  padding: 9px 18px;
  font-size: 13.5px;
  font-weight: 700;
  border: none;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.btn-primary {
  background: var(--red);
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  background: var(--red-dark);
}
.btn-primary:disabled {
  background: var(--ink-3);
  cursor: not-allowed;
}
.btn-ghost {
  background: #fff;
  border: 1.5px solid var(--line);
  color: var(--ink-2);
}
.btn-ghost:hover {
  background: var(--yellow-soft);
  color: var(--ink);
}

.typing {
  display: flex;
  gap: 5px;
  padding: 8px 0;
}
.typing i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-3);
  animation: blink 1.2s infinite;
}
.typing i:nth-child(2) {
  animation-delay: 0.2s;
}
.typing i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  0%, 80%, 100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}

.stage-text {
  font-size: 12px;
  color: var(--ink-2);
  margin-top: 6px;
}

.offline-note {
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 11.5px;
  margin: 8px 0;
}
.src-note {
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 11.5px;
  margin: 8px 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-2);
  background: rgba(43, 33, 24, 0.04);
  border: 1px solid rgba(43, 33, 24, 0.07);
}
.src-live {
  color: var(--green);
  background: var(--green-soft);
  border-color: rgba(30, 123, 79, 0.2);
}
.src-live::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(30, 123, 79, 0.14);
}

/* ---- 确认条 / 支付卡 ---- */
.delivery-note {
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--card-2, #fafafa);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-2);
}
.dn-fee {
  font-weight: 600;
}
.dn-addr {
  color: var(--ink-3, #888);
}

.confirm-bar {
  margin-top: 12px;
  background: var(--yellow-soft);
  border: 1.5px solid var(--yellow);
  border-radius: 12px;
  padding: 12px 14px;
}
.confirm-bar.warn {
  background: #FFF8F7;
  border-color: #F3D6D2;
}
.confirm-text {
  font-size: 13px;
  line-height: 1.65;
}
.confirm-text b {
  color: var(--red-dark);
  font-weight: 800;
}
.confirm-acts {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.pay-card {
  margin-top: 12px;
  background: var(--card);
  border: 1.5px solid var(--yellow);
  border-radius: 12px;
  padding: 14px 16px;
}
.pay-title {
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 8px;
}
.pay-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.pay-note {
  font-size: 11.5px;
  color: var(--ink-2);
  margin-top: 6px;
}
.pay-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pay-status {
  font-size: 12.5px;
  color: var(--ink-2);
  margin-top: 8px;
  min-height: 18px;
}
.pay-status.ok {
  color: var(--green);
  font-weight: 700;
}
.pay-status.bad {
  color: var(--red);
}
.pay-safe {
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 3px;
}
.pay-done {
  font-size: 14px;
  font-weight: 800;
  color: var(--green);
}

.upsell {
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 10px;
  padding: 12px 14px;
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.7;
}
.upsell b {
  color: var(--red-dark);
}
.upsell button {
  margin-top: 8px;
  background: var(--red);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 7px 16px;
  font-size: 12.5px;
  font-weight: 700;
}

/* ---- 输入区 ---- */
.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  background: var(--card);
  padding: 12px 20px 10px;
}

/* 开局选履约方式 */
.fulfil-pick {
  margin: 4px auto 18px;
  max-width: 460px;
  text-align: left;
}
.fulfil-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 10px;
  text-align: center;
}
.fulfil-opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.fulfil-opt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 14px 10px;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.16s;
  font-family: inherit;
}
.fulfil-opt:hover {
  border-color: var(--yellow);
  transform: translateY(-1px);
}
.fulfil-opt.on {
  border-color: var(--red);
  background: var(--yellow-soft);
  box-shadow: 0 0 0 1px var(--red) inset;
}
.fo-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #FAF5EC;
  color: var(--ink-2);
  margin-bottom: 2px;
}
.fulfil-opt.on .fo-icon {
  background: #fff;
  color: var(--red);
}
.fo-main {
  font-size: 14px;
  font-weight: 800;
  color: var(--ink);
}
.fo-sub {
  font-size: 11.5px;
  color: var(--ink-3, #888);
}
.fulfil-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--ink-2);
  text-align: center;
}
.empty-tip {
  margin: 0;
}

.empty-chips {
  justify-content: center;
  margin-top: 18px;
  gap: 8px;
}
.chips-label {
  width: 100%;
  font-size: 11.5px;
  color: var(--ink-3);
  margin-bottom: 2px;
}
.empty-chips .chip {
  background: #fff;
}
.empty-chips .chip:hover {
  border-color: var(--yellow);
  background: var(--yellow-soft);
  color: var(--ink);
}

/* 履约方式锁定提示 */
.fulfil-lock {
  max-width: 780px;
  margin: 0 auto 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ink-2);
}
.fl-badge {
  padding: 3px 9px;
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 999px;
  font-weight: 700;
  color: var(--red-dark);
  flex-shrink: 0;
}
.fl-text {
  flex: 1;
  min-width: 120px;
}

/* 外送地址条 */
.addr-bar {
  max-width: 780px;
  margin: 0 auto 10px;
  padding: 10px 12px;
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 12px;
}
.addr-bar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ab-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--red-dark);
}
.addr-chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  margin-top: 8px;
  padding-bottom: 2px;
}
.addr-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 320px;
  padding: 6px 10px;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.addr-chip.on {
  border-color: var(--red);
  background: #fff;
}
.addr-chip input {
  display: none;
}
.ac-tag {
  flex-shrink: 0;
  padding: 1px 5px;
  background: var(--red);
  color: #fff;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}
.ac-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-text b {
  font-weight: 800;
}
.addr-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ink-2);
}
.addr-hint.err {
  color: var(--red-dark);
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  margin-left: 6px;
  color: var(--red);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  text-decoration: underline;
}
.addr-form {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.af-row {
  display: flex;
  gap: 8px;
}
.af-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1.5px solid var(--line);
  border-radius: 9px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--card);
  outline: none;
}
.af-input:focus {
  border-color: var(--red);
}
.af-acts {
  display: flex;
  gap: 8px;
}
.af-note {
  margin: 0;
  font-size: 11px;
  color: var(--ink-3, #888);
  line-height: 1.6;
}

.composer-inner {
  max-width: 780px;
  margin: 0 auto;
  display: flex;
  gap: 10px;
  align-items: center;
  border: 1.5px solid var(--line);
  border-radius: 14px;
  padding: 7px 8px 7px 14px;
  transition: border-color 0.18s;
}
.composer-inner:focus-within {
  border-color: var(--red);
}
.composer-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 14px;
  background: transparent;
  color: var(--ink);
  min-width: 0;
}
.composer-input::placeholder {
  color: var(--ink-3);
}
.btn-send {
  background: var(--red);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 9px 20px;
  font-weight: 800;
  font-size: 13.5px;
  flex-shrink: 0;
}
.btn-send:disabled {
  background: var(--ink-3);
  cursor: not-allowed;
}
.composer-note {
  max-width: 780px;
  margin: 7px auto 0;
  text-align: center;
  font-size: 11px;
  color: var(--ink-3);
}

@media (max-width: 680px) {
  .chat-inner {
    padding: 14px 13px 8px;
  }
  .bubble {
    max-width: 94%;
  }
  .composer {
    padding: 10px 13px 8px;
  }
  .composer-note {
    font-size: 10.5px;
  }
}
</style>
