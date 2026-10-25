<script setup lang="ts">
/**
 * 积分商城
 *
 * 对应工具：mall-points-products（商品列表）、mall-product-detail（SKU）、
 * mall-create-order（下单，写操作）
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { thousands } from '../lib/format';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';
import type { MallProductDetail } from '../types';

const f = useFetch(() => api.mall());

const products = computed(() => f.data.value?.data ?? []);

/** 按 category 分组（服务端可能不给分类，那就全放一起） */
const grouped = computed(() => {
  const map = new Map<string, typeof products.value>();
  for (const p of products.value) {
    const k = p.category || '全部商品';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(p);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

/* -------- 详情 -------- */
const drawerOpen = ref(false);
const detailLoading = ref(false);
const detailErr = ref<unknown>(undefined);
const detail = ref<MallProductDetail | null>(null);

async function openDetail(spuId: number | string | undefined, name: string) {
  if (spuId === undefined) {
    toast(`暂时无法查看「${name}」的详情`, true);
    return;
  }
  drawerOpen.value = true;
  detailLoading.value = true;
  detailErr.value = undefined;
  detail.value = null;
  try {
    const r = await api.mallDetail(spuId);
    detail.value = r.data ?? null;
  } catch (e) {
    detailErr.value = e;
  } finally {
    detailLoading.value = false;
  }
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>积分商城</h2>
        <p class="panel-sub">查看可兑换商品、所需积分和库存。</p>
      </div>
      <div class="head-acts">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
      </div>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && products.length === 0"
      empty-title="商城暂时没有商品"
      empty-text="暂无可兑换商品，可稍后刷新查看。"
      :skeleton-rows="4"
      @retry="f.reload()"
    >
      <div v-for="g in grouped" :key="g.name" class="group">
        <h3 class="sec">{{ g.name }} <span class="sec-count">{{ g.items.length }}</span></h3>
        <div class="goods">
          <button v-for="p in g.items" :key="String(p.spuId ?? p.name)" class="good" type="button" @click="openDetail(p.spuId, p.name)">
            <img v-if="p.image" :src="p.image" :alt="p.name" class="g-img" loading="lazy" />
            <div v-else class="g-img g-ph"><AppIcon name="gift" :size="20" /></div>
            <div class="g-body">
              <b class="g-name">{{ p.name }}</b>
              <span v-if="p.desc" class="g-desc">{{ p.desc }}</span>
              <div class="g-tags">
                <span v-if="p.stock !== undefined" class="tag" :class="p.stock > 0 ? 'green' : 'gray'">
                  {{ p.stock > 0 ? `库存 ${p.stock}` : '已兑完' }}
                </span>
                <span v-for="t in p.tags.slice(0, 2)" :key="t" class="tag gray">{{ t }}</span>
              </div>
            </div>
            <div class="g-price">
              <b>{{ p.points !== undefined ? thousands(p.points) : '—' }}</b>
              <span>积分</span>
              <s v-if="p.originalPoints">{{ thousands(p.originalPoints) }}</s>
            </div>
          </button>
        </div>
      </div>
    </AsyncBlock>

    <!-- 详情抽屉 -->
    <Teleport to="body">
      <div v-if="drawerOpen" class="drawer-mask" @click.self="drawerOpen = false">
        <aside class="drawer">
          <header class="d-head">
            <h3>{{ detail?.name || '商品详情' }}</h3>
            <button class="d-close" type="button" aria-label="关闭" @click="drawerOpen = false"><AppIcon name="close" :size="16" /></button>
          </header>
          <div class="d-body">
            <AsyncBlock
              :loading="detailLoading"
              :error="detailErr"
              :empty="!detailLoading && !detailErr && !detail"
              empty-title="没能加载商品详情"
              :skeleton-rows="3"
            >
              <template v-if="detail">
                <img v-if="detail.image" :src="detail.image" :alt="detail.name" class="d-img" />
                <p v-if="detail.description" class="d-desc">{{ detail.description }}</p>

                <h4 class="d-sec">商品规格</h4>
                <div v-if="detail.skus.length" class="skus">
                  <div v-for="(s, i) in detail.skus" :key="i" class="sku">
                    <span class="sku-name">{{ s.name || s.spec || `规格 ${i + 1}` }}</span>
                    <span v-if="s.stock !== undefined" class="sku-stock">库存 {{ s.stock }}</span>
                    <b v-if="s.points !== undefined" class="sku-pt">{{ thousands(s.points) }} 积分</b>
                  </div>
                </div>
                <p v-else class="d-none">这个商品没有多规格。</p>

                <div v-if="detail.images.length > 1" class="d-gallery">
                  <img v-for="(u, i) in detail.images" :key="i" :src="u" :alt="`${detail.name} ${i + 1}`" loading="lazy" />
                </div>

                <p class="d-note">如需兑换，请前往麦当劳 App 确认商品及兑换条件。</p>
              </template>
            </AsyncBlock>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.head-acts {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.sec {
  font-size: 13px;
  font-weight: 800;
  margin: 16px 0 9px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.sec-count {
  font-size: 10.5px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
}

.goods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}

.good {
  display: flex;
  gap: 11px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 13px;
  text-align: left;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.good:hover {
  border-color: var(--yellow);
  box-shadow: var(--shadow);
}
.g-img {
  width: 54px;
  height: 54px;
  border-radius: 9px;
  object-fit: cover;
  background: var(--yellow-soft);
  flex-shrink: 0;
}
.g-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  opacity: 0.55;
}
.g-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.g-name {
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.g-desc {
  font-size: 10.5px;
  color: var(--ink-3);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.g-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.g-tags .tag {
  font-size: 9.5px;
  padding: 0 5px;
}
.g-price {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}
.g-price b {
  font-size: 14px;
  font-weight: 900;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
  line-height: 1.2;
}
.g-price span {
  font-size: 9.5px;
  color: var(--ink-3);
}
.g-price s {
  font-size: 9.5px;
  color: var(--ink-3);
}

/* 抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(43, 33, 24, 0.4);
  z-index: 300;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: 420px;
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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.d-head h3 {
  font-size: 15px;
  font-weight: 800;
}
.d-close {
  border: none;
  background: transparent;
  font-size: 17px;
  color: var(--ink-3);
  padding: 2px 6px;
  border-radius: 7px;
  line-height: 1;
}
.d-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 30px;
}
.d-img {
  width: 100%;
  max-height: 200px;
  object-fit: cover;
  border-radius: var(--radius);
  background: var(--yellow-soft);
}
.d-desc {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.7;
  margin-top: 12px;
}
.d-sec {
  font-size: 12px;
  font-weight: 800;
  margin: 18px 0 9px;
}
.skus {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.sku {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 12px;
  font-size: 12px;
}
.sku-name {
  flex: 1;
  font-weight: 600;
}
.sku-stock {
  font-size: 10.5px;
  color: var(--ink-3);
}
.sku-pt {
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 12px;
}
.d-gallery {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 14px;
}
.d-gallery img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
  background: var(--yellow-soft);
}
.d-none {
  font-size: 12px;
  color: var(--ink-3);
}
.d-note {
  margin-top: 16px;
  font-size: 11px;
  color: var(--ink-3);
  line-height: 1.7;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
</style>
