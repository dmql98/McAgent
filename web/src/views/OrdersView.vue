<script setup lang="ts">
/**
 * 订单记录
 *
 * 对应工具：order-list / query-order（餐品）、mall-order-list / mall-order-detail（商城）、
 * query-survey-coupon（评价返券）
 *
 * 关键点：MCP 的 orderStatus 是数字枚举（1/2/4/6/7/8/10），
 * 后端已翻译成中文；未知值原样透出，不丢数据。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { money, thousands } from '../lib/format';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';
import type { OrderCard } from '../types';

type Tab = 'food' | 'mall';
const tab = ref<Tab>('food');

const f = useFetch(() => api.explorerOrders());

const food = computed(() => f.data.value?.foodOrders.data ?? []);
const mall = computed(() => f.data.value?.mallOrders.data ?? []);
const list = computed<OrderCard[]>(() => (tab.value === 'food' ? food.value : mall.value));

/* ---------- 单笔详情 ---------- */
const detailOpen = ref(false);
const detailId = ref('');
const detailKind = ref<'food' | 'mall'>('food');
const detailLoading = ref(false);
const detailData = ref<OrderCard | null>(null);
const detailErr = ref<unknown>(undefined);

async function openDetail(o: OrderCard) {
  detailId.value = o.orderId;
  detailKind.value = tab.value;
  detailOpen.value = true;
  detailLoading.value = true;
  detailErr.value = undefined;
  detailData.value = null;
  try {
    const r = await api.orderDetail(o.orderId, tab.value);
    detailData.value = r.detail.data ?? null;
  } catch (e) {
    detailErr.value = e;
  } finally {
    detailLoading.value = false;
  }
}

/** 状态色：完成绿、取消灰、进行中黄 */
function statusClass(s?: string): string {
  if (!s) return 'gray';
  if (s.includes('完成') || s.includes('评价')) return 'green';
  if (s.includes('取消')) return 'gray';
  return '';
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>订单记录</h2>
        <p class="panel-sub">
          查看餐品和商城订单，点击订单查看详情及当前进度。
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
    </div>

    <div class="tabs">
      <button class="chip" :class="{ on: tab === 'food' }" type="button" @click="tab = 'food'">
        餐品订单 {{ food.length }}
      </button>
      <button class="chip" :class="{ on: tab === 'mall' }" type="button" @click="tab = 'mall'">
        商城订单 {{ mall.length }}
      </button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && list.length === 0"
      empty-title="还没有订单"
      empty-text="下单后可在这里查看订单记录。"
      :skeleton-rows="3"
      @retry="f.reload()"
    >
      <div class="orders">
        <article v-for="o in list" :key="o.orderId" class="order" @click="openDetail(o)">
          <div class="o-head">
            <div class="o-id">
              <b>{{ o.orderId }}</b>
              <span v-if="o.createdAt" class="o-time">{{ o.createdAt }}</span>
            </div>
            <span class="tag" :class="statusClass(o.statusText)">{{ o.statusText || '状态未知' }}</span>
          </div>

          <p v-if="o.storeName" class="o-store"><AppIcon name="store" :size="13" /> {{ o.storeName }}</p>

          <div class="o-items">
            <span v-for="(it, i) in o.items.slice(0, 4)" :key="i" class="o-item">
              {{ it.name }}<em v-if="it.quantity && it.quantity > 1">×{{ it.quantity }}</em>
            </span>
            <span v-if="o.items.length > 4" class="o-more">等 {{ o.items.length }} 项</span>
            <span v-if="o.items.length === 0" class="o-more">没有餐品明细</span>
          </div>

          <div class="o-foot">
            <span v-if="o.total !== undefined" class="o-total">{{ money(o.total) }}</span>
            <span v-if="o.realTotal !== undefined && o.realTotal !== o.total" class="o-real">
              实付 {{ money(o.realTotal) }}
            </span>
            <!-- 商城订单是积分兑换，没有金额，只有件数 -->
            <span v-if="o.total !== undefined ? false : o.totalCount !== undefined" class="o-real">
              共 {{ o.totalCount }} 件
            </span>
            <span class="o-detail-link">看详情 →</span>
          </div>
        </article>
      </div>
    </AsyncBlock>

    <!-- 详情抽屉 -->
    <Teleport to="body">
      <div v-if="detailOpen" class="drawer-mask" @click.self="detailOpen = false">
        <aside class="drawer">
          <header class="d-head">
            <div>
              <h3>订单 {{ detailId }}</h3>
              <span class="d-kind">{{ detailKind === 'food' ? '餐品订单' : '商城订单' }}</span>
            </div>
            <button class="d-close" type="button" aria-label="关闭" @click="detailOpen = false"><AppIcon name="close" :size="16" /></button>
          </header>
          <div class="d-body">
            <AsyncBlock
              :loading="detailLoading"
              :error="detailErr"
              :empty="!detailLoading && !detailErr && !detailData"
              empty-title="没能加载订单详情"
              :skeleton-rows="4"
            >
              <template v-if="detailData">
                <div class="d-rows">
                  <div class="d-row">
                    <span>状态</span>
                    <b>{{ detailData.statusText || '状态待确认' }}</b>
                  </div>
                  <div v-if="detailData.storeName" class="d-row">
                    <span>门店</span>
                    <b>{{ detailData.storeName }}</b>
                  </div>
                  <div v-if="detailData.storeAddress" class="d-row">
                    <span>地址</span>
                    <b>{{ detailData.storeAddress }}</b>
                  </div>
                  <div v-if="detailData.createdAt" class="d-row">
                    <span>下单时间</span>
                    <b>{{ detailData.createdAt }}</b>
                  </div>
                  <div v-if="detailData.total !== undefined" class="d-row">
                    <span>合计</span>
                    <b class="d-money">{{ money(detailData.total) }}</b>
                  </div>
                  <div v-if="detailData.realTotal !== undefined" class="d-row">
                    <span>实付</span>
                    <b class="d-money">{{ money(detailData.realTotal) }}</b>
                  </div>
                  <div v-for="(e, i) in detailData.extra" :key="i" class="d-row">
                    <span>{{ e.label }}</span>
                    <b>{{ e.value }}</b>
                  </div>
                </div>

                <h4 v-if="detailData.items.length" class="d-sec">餐品</h4>
                <div v-if="detailData.items.length" class="d-items">
                  <div v-for="(it, i) in detailData.items" :key="i" class="d-item">
                    <img v-if="it.image" :src="it.image" :alt="it.name" class="di-img" loading="lazy" />
                    <div class="di-body">
                      <b>{{ it.name }}</b>
                      <span v-if="it.combo?.length" class="di-combo">含 {{ it.combo.join('、') }}</span>
                    </div>
                    <span v-if="it.quantity" class="di-qty">×{{ it.quantity }}</span>
                    <span v-if="it.price !== undefined" class="di-price">{{ money(it.price) }}</span>
                    <span v-else-if="it.points !== undefined" class="di-price">{{ thousands(it.points) }} 积分</span>
                  </div>
                </div>

                <a v-if="detailData.payUrl" :href="detailData.payUrl" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="margin-top: 14px">
                  去付款
                </a>
              </template>
            </AsyncBlock>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.orders {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 15px;
  cursor: pointer;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.order:hover {
  border-color: var(--yellow);
  box-shadow: var(--shadow);
}

.o-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.o-id b {
  font-size: 12.5px;
  font-family: 'SF Mono', Consolas, monospace;
  font-weight: 700;
}
.o-time {
  display: block;
  font-size: 10.5px;
  color: var(--ink-3);
  margin-top: 2px;
}

.o-store {
  font-size: 11.5px;
  color: var(--ink-2);
  margin-top: 7px;
}

.o-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.o-item {
  font-size: 11.5px;
  background: #FEFCF7;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--ink-2);
}
.o-item em {
  font-style: normal;
  color: var(--red-dark);
  font-weight: 700;
  margin-left: 2px;
}
.o-more {
  font-size: 11px;
  color: var(--ink-3);
  align-self: center;
}

.o-foot {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed var(--line);
}
.o-total {
  font-size: 15px;
  font-weight: 900;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
}
.o-real {
  font-size: 11px;
  color: var(--ink-3);
}
.o-detail-link {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--red);
  font-weight: 700;
}

/* ---- 抽屉 ---- */
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(43, 33, 24, 0.4);
  z-index: 300;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: 440px;
  max-width: 94vw;
  height: 100%;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  box-shadow: -12px 0 40px rgba(43, 33, 24, 0.2);
}
.d-head {
  flex-shrink: 0;
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 14px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.d-head h3 {
  font-size: 14px;
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
}
.d-kind {
  font-size: 10.5px;
  color: var(--ink-3);
}
.d-close {
  border: none;
  background: transparent;
  font-size: 17px;
  color: var(--ink-3);
  padding: 2px 6px;
  border-radius: 7px;
  line-height: 1;
  flex-shrink: 0;
}
.d-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 30px;
}

.d-rows {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 4px 14px;
}
.d-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 12.5px;
}
.d-row:last-child {
  border-bottom: none;
}
.d-row span {
  color: var(--ink-3);
  flex-shrink: 0;
}
.d-row b {
  text-align: right;
  font-weight: 700;
  word-break: break-word;
}
.d-money {
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
}

.d-sec {
  font-size: 12.5px;
  font-weight: 800;
  margin: 16px 0 9px;
}
.d-items {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.d-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 11px;
  font-size: 12px;
}
.di-img {
  width: 34px;
  height: 34px;
  border-radius: 7px;
  object-fit: cover;
  background: var(--yellow-soft);
  flex-shrink: 0;
}
.di-body {
  flex: 1;
  min-width: 0;
}
.di-body b {
  font-weight: 700;
  display: block;
}
.di-combo {
  font-size: 10.5px;
  color: var(--ink-3);
  display: block;
  margin-top: 2px;
}
.di-qty {
  font-size: 11.5px;
  color: var(--ink-2);
  font-family: 'SF Mono', Consolas, monospace;
}
.di-price {
  font-size: 12px;
  font-weight: 800;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
}
</style>
