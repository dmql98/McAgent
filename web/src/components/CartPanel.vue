<script setup lang="ts">
/**
 * 购物车侧栏
 *
 * 产品变化：菜单从「聊天气泡里的只读卡片」变成「聊天旁边可编辑的清单」。
 *
 * 为什么这样改：
 *   1. 气泡里的菜单只能看、不能删 —— 用户想吃掉一份薯条只能重新问一遍，
 *      而重新问必然整单重配，越改越乱。
 *   2. 对话和购物车是两种操作：毒舌点评适合在聊天里看，
 *      但"删掉薯条、可乐加一杯"是表单活，塞在瀑布流气泡里很难用。
 *
 * 交互约定（和对话的分工）：
 *   · 手动改（±/删/搜加购/清空）→ 走 REST，立刻生效
 *   · 通过对话修改（"薯条删了"）→ 走对话，后端识别后改同一份车
 *   两条路改的是**同一份**后端购物车，所以不会打架。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';
import { money } from '../lib/format';
import AppIcon from './AppIcon.vue';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import type { Cart, Fulfillment, SearchProduct } from '../types';

const props = defineProps<{
  fulfillment: Fulfillment;
  /** 访客/未登录：只能看不能改 */
  readonly?: boolean;
  /** 门店名（外送/到店都显示，让用户知道这是哪家店的价） */
  store?: string;
}>();

const emit = defineEmits<{
  /** 购物车变了（数量/内容/合计），聊天区要更新摘要 */
  (e: 'change', cart: Cart): void;
  /** 去下单 */
  (e: 'checkout', cart: Cart): void;
  /** 窄屏下关闭抽屉 */
  (e: 'close'): void;
}>();

const cart = ref<Cart | null>(null);
const loading = ref(false);
const busyId = ref('');
const clearing = ref(false);

/* ---- 搜索加购 ---- */
const searchOpen = ref(false);
const keyword = ref('');
const searching = ref(false);
const results = ref<SearchProduct[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const items = computed(() => cart.value?.items ?? []);
const count = computed(() => cart.value?.count ?? 0);
const isEmpty = computed(() => items.value.length === 0);
const fee = computed(() => cart.value?.deliveryFee);

/** 外送时商品合计 + 配送费才等于合计，中间要拆开显示 */
const showFeeBreakdown = computed(() => props.fulfillment === '外送' && (fee.value?.delivery ?? 0) > 0);

async function load(): Promise<void> {
  if (props.readonly) {
    cart.value = null;
    return;
  }
  loading.value = true;
  try {
    cart.value = await api.getCart({ fulfillment: props.fulfillment });
    emit('change', cart.value);
  } catch (e) {
    toast(messageOf(e) || '购物车加载失败，请重试', true);
  } finally {
    loading.value = false;
  }
}

function apply(next: Cart): void {
  cart.value = next;
  emit('change', next);
}

async function changeQty(id: string, delta: number): Promise<void> {
  const it = items.value.find((x) => x.id === id);
  if (!it || busyId.value) return;
  const qty = it.qty + delta;
  busyId.value = id;
  try {
    const next =
      qty <= 0
        ? await api.removeCartItem(id, { fulfillment: props.fulfillment })
        : await api.updateCartItem(id, { qty, fulfillment: props.fulfillment });
    apply(next);
  } catch (e) {
    toast(messageOf(e) || '修改失败，请稍后重试', true);
  } finally {
    busyId.value = '';
  }
}

async function remove(id: string, name: string): Promise<void> {
  if (busyId.value) return;
  busyId.value = id;
  try {
    apply(await api.removeCartItem(id, { fulfillment: props.fulfillment }));
    toast(`已删除「${name}」`);
  } catch (e) {
    toast(messageOf(e) || '删除失败，请稍后重试', true);
  } finally {
    busyId.value = '';
  }
}

async function clearAll(): Promise<void> {
  if (clearing.value || isEmpty.value) return;
  clearing.value = true;
  try {
    apply(await api.clearCart({ fulfillment: props.fulfillment }));
    toast('购物车已清空');
  } catch (e) {
    toast(messageOf(e) || '清空失败', true);
  } finally {
    clearing.value = false;
  }
}

async function add(p: SearchProduct): Promise<void> {
  if (busyId.value) return;
  busyId.value = p.productId;
  try {
    apply(
      await api.addToCart({
        productId: p.productId,
        qty: 1,
        fulfillment: props.fulfillment,
        ...(cart.value?.store ? { store: cart.value.store } : {}),
        ...(cart.value?.storeCode ? { storeCode: cart.value.storeCode } : {}),
      }),
    );
    toast(`已添加「${p.name}」`);
  } catch (e) {
    toast(messageOf(e) || '添加失败，请稍后重试', true);
  } finally {
    busyId.value = '';
  }
}

/** 搜索防抖 300ms：每敲一个字就打一次 MCP 会很浪费 */
watch(keyword, (k) => {
  if (searchTimer) clearTimeout(searchTimer);
  if (!searchOpen.value) return;
  searchTimer = setTimeout(() => void doSearch(k), 300);
});

async function doSearch(k: string): Promise<void> {
  if (props.readonly) return;
  searching.value = true;
  try {
    const res = await api.searchProducts(k, { fulfillment: props.fulfillment });
    results.value = res.items;
  } catch {
    results.value = [];
  } finally {
    searching.value = false;
  }
}

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) {
    results.value = [];
    keyword.value = '';
    void doSearch('');
  } else {
    keyword.value = '';
    results.value = [];
  }
}

/* 切履约方式要重新读（两份车是独立的） */
watch(
  () => props.fulfillment,
  () => void load(),
  { immediate: true },
);

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

defineExpose({ reload: load });
</script>

<template>
  <aside class="cart-panel">
    <header class="cp-head">
      <div class="cp-title">
        购物车
        <span v-if="count" class="cp-badge">{{ count }}</span>
      </div>
      <div class="cp-head-acts">
        <button v-if="!readonly && !isEmpty" class="cp-mini" type="button" :disabled="clearing" @click="clearAll">
          清空
        </button>
        <button class="cp-mini cp-close" type="button" aria-label="收起购物车" @click="emit('close')"><AppIcon name="close" :size="15" /></button>
      </div>
    </header>

    <div v-if="props.store" class="cp-store">{{ props.store }} · {{ props.fulfillment }}</div>

    <!-- 空车 -->
    <div v-if="isEmpty && !loading" class="cp-empty">
      <div class="cp-empty-icon"><AppIcon name="bag" :size="26" :stroke="1.6" /></div>
      <p>购物车暂无餐品</p>
      <p v-if="readonly" class="cp-empty-hint">可先体验点餐，<br />登录后可添加餐品并下单</p>
      <p v-else class="cp-empty-hint">输入想吃的餐品、人数和预算，<br />也可以搜索餐品后添加</p>
    </div>

    <!-- 列表 -->
    <div v-else class="cp-list">
      <div v-for="it in items" :key="it.id" class="cp-item" :class="{ busy: busyId === it.id }">
        <div class="ci-main">
          <div class="ci-name">{{ it.name }}</div>
          <div v-if="it.spec || it.why" class="ci-sub">
            <span v-if="it.spec" class="ci-spec">{{ it.spec }}</span>
            <span v-if="it.why" class="ci-why">{{ it.why }}</span>
          </div>
        </div>
        <div class="ci-ops">
          <div class="ci-price">{{ money(it.price * it.qty) }}</div>
          <div class="ci-stepper">
            <button type="button" :disabled="busyId === it.id || readonly" @click="changeQty(it.id, -1)">
              <AppIcon v-if="it.qty === 1" name="trash" :size="13" /><template v-else>−</template>
            </button>
            <span>{{ it.qty }}</span>
            <button type="button" :disabled="busyId === it.id || readonly" @click="changeQty(it.id, 1)"><AppIcon name="plus" :size="13" /></button>
          </div>
          <button
            v-if="!readonly"
            class="ci-del"
            type="button"
            :disabled="busyId === it.id"
            aria-label="删除"
            @click="remove(it.id, it.name)"
          >
            <AppIcon name="close" :size="13" />
          </button>
        </div>
      </div>
    </div>

    <!-- 搜索加购 -->
    <div v-if="!readonly" class="cp-search-wrap">
      <button class="cp-search-toggle" type="button" @click="toggleSearch">
        {{ searchOpen ? '− 收起' : '＋ 手动加一份' }}
      </button>

      <div v-if="searchOpen" class="cp-search">
        <input
          v-model="keyword"
          class="cp-input"
          type="text"
          placeholder="搜商品名，如 薯条 / 可乐"
          autocomplete="off"
        />
        <div v-if="searching" class="cp-searching">正在搜索…</div>
        <div v-else-if="results.length === 0" class="cp-searching">没搜到，换个词试试</div>
        <div v-else class="cp-results">
          <button
            v-for="p in results.slice(0, 20)"
            :key="p.productId"
            class="cp-result"
            type="button"
            :disabled="busyId === p.productId"
            @click="add(p)"
          >
            <span class="cr-name">{{ p.name }}</span>
            <span class="cr-price">{{ money(p.price) }}</span>
            <span class="cr-add">＋</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 合计 -->
    <footer v-if="!isEmpty" class="cp-foot">
      <div v-if="showFeeBreakdown" class="cp-fee">
        <span>商品 {{ money(cart!.subtotal) }}</span>
        <span>配送 {{ money(fee!.delivery) }}</span>
        <span v-if="fee!.packing > 0">打包 {{ money(fee!.packing) }}</span>
      </div>
      <div class="cp-total">
        <span>合计</span>
        <b>{{ money(cart!.total) }}</b>
      </div>
      <button class="cp-checkout" type="button" :disabled="readonly" @click="cart && emit('checkout', cart)">
        去下单
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.cart-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  overflow: hidden;
}

/* ---- 头部 ---- */
.cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.cp-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 6px;
}
.cp-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--red);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.cp-head-acts {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cp-mini {
  border: none;
  background: none;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.cp-mini:hover:not(:disabled) {
  color: var(--red);
  background: var(--yellow-soft);
}
.cp-mini:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 关闭按钮只在窄屏抽屉里显示 */
.cp-close {
  display: none;
  font-size: 14px;
}

.cp-store {
  padding: 8px 16px;
  font-size: 11px;
  color: var(--ink-3);
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 空车 ---- */
.cp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 16px;
  color: var(--ink-3);
  text-align: center;
}
.cp-empty-icon {
  display: flex;
  justify-content: center;
  color: var(--ink-3);
  opacity: 0.7;
  margin-bottom: 4px;
}
.cp-empty p {
  font-size: 13px;
  color: var(--ink-2);
}
.cp-empty-hint {
  font-size: 12px !important;
  color: var(--ink-3) !important;
  line-height: 1.6;
}

/* ---- 列表 ---- */
.cp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}
.cp-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px dashed var(--line);
  transition: opacity 0.15s;
}
.cp-item:last-child {
  border-bottom: none;
}
.cp-item.busy {
  opacity: 0.5;
}
.ci-main {
  flex: 1;
  min-width: 0;
}
.ci-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
  word-break: break-all;
}
.ci-sub {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
}
.ci-spec {
  color: var(--blue);
  background: var(--blue-soft);
  padding: 1px 5px;
  border-radius: 4px;
}
.ci-why {
  color: var(--ink-3);
}
.ci-ops {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  flex-shrink: 0;
}
.ci-price {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.ci-stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
.ci-stepper button {
  width: 24px;
  height: 22px;
  border: none;
  background: #fff;
  color: var(--ink-2);
  font-size: 13px;
  cursor: pointer;
  line-height: 1;
}
.ci-stepper button:hover:not(:disabled) {
  background: var(--yellow-soft);
  color: var(--red);
}
.ci-stepper button:disabled {
  opacity: 0.35;
  cursor: default;
}
.ci-stepper span {
  min-width: 20px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.ci-del {
  border: none;
  background: none;
  color: var(--ink-3);
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
}
.ci-del:hover:not(:disabled) {
  color: var(--red);
}

/* ---- 搜索 ---- */
.cp-search-wrap {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding: 8px 12px;
}
.cp-search-toggle {
  width: 100%;
  padding: 7px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: none;
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.cp-search-toggle:hover {
  border-color: var(--yellow);
  color: var(--red);
  background: var(--yellow-soft);
}
.cp-search {
  margin-top: 8px;
}
.cp-input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--ink);
  outline: none;
  font-family: inherit;
}
.cp-input:focus {
  border-color: var(--yellow);
}
.cp-searching {
  padding: 10px 4px;
  font-size: 11px;
  color: var(--ink-3);
  text-align: center;
}
.cp-results {
  margin-top: 6px;
  max-height: 168px;
  overflow-y: auto;
}
.cp-result {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 4px;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
}
.cp-result:hover:not(:disabled) {
  background: var(--yellow-soft);
}
.cp-result:disabled {
  opacity: 0.4;
}
.cr-name {
  flex: 1;
  font-size: 12px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cr-price {
  font-size: 11px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.cr-add {
  color: var(--red);
  font-weight: 700;
  font-size: 13px;
}

/* ---- 合计 ---- */
.cp-foot {
  flex-shrink: 0;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--line);
  background: #fffdf8;
}
.cp-fee {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--ink-3);
  margin-bottom: 5px;
}
.cp-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 9px;
}
.cp-total span {
  font-size: 12px;
  color: var(--ink-2);
}
.cp-total b {
  font-size: 19px;
  color: var(--red);
  font-variant-numeric: tabular-nums;
}
.cp-checkout {
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 10px;
  background: var(--red);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
}
.cp-checkout:hover:not(:disabled) {
  background: var(--red-dark);
}
.cp-checkout:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 窄屏：作为抽屉出现，关闭按钮要可见 */
@media (max-width: 1100px) {
  .cp-close {
    display: block;
  }
}
</style>
