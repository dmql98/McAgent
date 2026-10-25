<script setup lang="ts">
/**
 * 我的券包
 *
 * 对应工具：query-my-coupons（卡包）/ available-coupons（可领）/ query-store-coupons（门店券）
 *
 * 三类券的返回格式完全不同：前两类是 markdown 券面卡片，第三类是 JSON。
 * 后端统一成了 CouponCard，这里按 kind 分栏。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { money } from '../lib/format';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';
import type { CouponCard } from '../types';

type Tab = 'card' | 'claimable' | 'store';
const tab = ref<Tab>('card');

const f = useFetch(() => api.coupons());

const card = computed(() => f.data.value?.card.data ?? []);
const claimable = computed(() => f.data.value?.claimable.data ?? []);
const storeCoupons = computed(() => f.data.value?.storeCoupons.data ?? []);

const current = computed<CouponCard[]>(() => {
  if (tab.value === 'card') return card.value;
  if (tab.value === 'claimable') return claimable.value;
  return storeCoupons.value;
});

const tabs = computed(() => [
  { key: 'card' as Tab, label: '卡包券', count: card.value.length, hint: '已经在你账号里的' },
  { key: 'claimable' as Tab, label: '可领券', count: claimable.value.length, hint: '还没领，领了才能用' },
  { key: 'store' as Tab, label: '门店券', count: storeCoupons.value.length, hint: '当前门店专属' },
]);

const claiming = ref<Set<string>>(new Set());

async function claim(c: CouponCard) {
  claiming.value.add(c.id);
  try {
    await api.claimCoupon(c.id);
    toast(`领到了：${c.title}`);
    await f.reload();
  } catch (e) {
    toast(messageOf(e) || '领取失败', true);
  } finally {
    claiming.value.delete(c.id);
  }
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>我的券包</h2>
        <p class="panel-sub">
          查看已领取、可领取和当前门店的优惠券。
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
    </div>

    <!-- 分栏 -->
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ on: tab === t.key }"
        type="button"
        @click="tab = t.key"
      >
        <b>{{ t.label }}</b>
        <span class="tab-count">{{ t.count }}</span>
        <span class="tab-hint">{{ t.hint }}</span>
      </button>
    </div>

    <div class="src-line">
      <span v-if="f.data.value?.store">当前门店：{{ f.data.value.store.name }}</span>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && current.length === 0"
      :empty-title="tab === 'card' ? '卡包里没有券' : tab === 'claimable' ? '现在没有可领的券' : '这家店没有专属券'"
      empty-text="暂无相关优惠券，可切换分类查看或稍后刷新。"
      :skeleton-rows="3"
      @retry="f.reload()"
    >
      <div class="coupons">
        <article v-for="c in current" :key="c.id" class="coupon" :class="c.kind">
          <div class="c-left">
            <div v-if="c.price !== undefined" class="c-price">
              <b>{{ money(c.price) }}</b>
              <span v-if="c.priceNote">{{ c.priceNote }}</span>
            </div>
            <div v-else class="c-price c-price-none">
              <b>{{ c.status || '券' }}</b>
            </div>
          </div>

          <div class="c-body">
            <h3>{{ c.title }}</h3>
            <div class="c-meta">
              <span v-if="c.validity"><AppIcon name="calendar" :size="12" /> {{ c.validity }}</span>
              <span v-if="c.receivedAt">领取于 {{ c.receivedAt }}</span>
            </div>
            <div v-if="c.products?.length" class="c-products">
              适用：{{ c.products.slice(0, 4).join('、') }}{{ c.products.length > 4 ? ' 等' : '' }}
            </div>
            <div v-if="c.tags.length || c.status" class="c-tags">
              <span v-if="c.status" class="tag gray">{{ c.status }}</span>
              <span v-for="t in c.tags" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>

          <div v-if="c.kind === 'claimable'" class="c-act">
            <button
              class="btn btn-primary btn-sm"
              type="button"
              :disabled="claiming.has(c.id)"
              @click="claim(c)"
            >
              {{ claiming.has(c.id) ? '领取中…' : '领取' }}
            </button>
          </div>
          <div v-else-if="c.code" class="c-code">
            <span class="c-code-label">券码</span>
            <b>{{ c.code }}</b>
          </div>
        </article>
      </div>
    </AsyncBlock>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 9px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.tab {
  flex: 1;
  min-width: 150px;
  text-align: left;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 14px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: border-color 0.18s, background 0.18s;
}
.tab:hover {
  border-color: var(--yellow);
}
.tab.on {
  border-color: var(--red);
  background: #FFFCF8;
}
.tab b {
  font-size: 13px;
  font-weight: 800;
}
.tab-count {
  font-size: 19px;
  font-weight: 900;
  color: var(--red-dark);
  line-height: 1.2;
  font-family: 'SF Mono', Consolas, monospace;
}
.tab-hint {
  font-size: 10.5px;
  color: var(--ink-3);
}

.coupons {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.coupon {
  display: flex;
  align-items: stretch;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.18s;
}
.coupon:hover {
  border-color: var(--yellow);
}
.coupon.claimable {
  border-left: 3px solid var(--yellow);
}
.coupon.store {
  border-left: 3px solid var(--red);
}

.c-left {
  width: 96px;
  flex-shrink: 0;
  background: linear-gradient(140deg, var(--red) 0%, var(--red-dark) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 8px;
}
.c-price {
  text-align: center;
  color: #fff;
}
.c-price b {
  display: block;
  font-size: 19px;
  font-weight: 900;
  line-height: 1.2;
  letter-spacing: -0.5px;
}
.c-price span {
  display: block;
  font-size: 10px;
  opacity: 0.9;
  margin-top: 2px;
}
.c-price-none b {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
}

.c-body {
  flex: 1;
  padding: 12px 14px;
  min-width: 0;
}
.c-body h3 {
  font-size: 13.5px;
  font-weight: 800;
  line-height: 1.45;
  margin-bottom: 4px;
}
.c-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--ink-3);
}
.c-products {
  font-size: 11.5px;
  color: var(--ink-2);
  margin-top: 5px;
  line-height: 1.55;
}
.c-tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 7px;
}
.c-tags .tag {
  font-size: 10px;
  padding: 0 6px;
}

.c-act {
  display: flex;
  align-items: center;
  padding: 0 14px 0 0;
  flex-shrink: 0;
}

.c-code {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  padding: 0 14px 0 0;
  flex-shrink: 0;
}
.c-code-label {
  font-size: 9.5px;
  color: var(--ink-3);
}
.c-code b {
  font-size: 11px;
  font-family: 'SF Mono', Consolas, monospace;
  color: var(--ink-2);
  letter-spacing: 0.5px;
}

@media (max-width: 620px) {
  .coupon {
    flex-wrap: wrap;
  }
  .c-left {
    width: 100%;
    padding: 9px;
  }
  .c-price b {
    font-size: 17px;
  }
}
</style>
