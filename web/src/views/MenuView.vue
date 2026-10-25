<script setup lang="ts">
/**
 * 菜单全量
 *
 * 对应工具：query-meals（分类 + 常点）、query-meal-detail（特制项 / 套餐组成）
 *
 * 关键结构：query-meals 的 meals 是以 productCode 为键的对象（不是数组），
 * 后端已经归一化成 categories[]，这里直接用。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { money } from '../lib/format';
import AsyncBlock from '../components/AsyncBlock.vue';
import MealDrawer from '../components/MealDrawer.vue';
import type { MenuCard } from '../types';

const beType = ref<1 | 5>(1);
const q = ref('');
const activeCat = ref('');

const f = useFetch(() => api.explorerMenu({ beType: beType.value }));

const menu = computed(() => f.data.value?.data);

/** 全部餐品扁平化，供搜索 */
const allItems = computed<MenuCard[]>(() => {
  const m = menu.value;
  if (!m) return [];
  return m.categories.flatMap((c) => c.items);
});

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  const cat = activeCat.value;
  const cats = menu.value?.categories ?? [];

  return cats
    .filter((c) => !cat || c.name === cat)
    .map((c) => ({
      name: c.name,
      items: kw ? c.items.filter((i) => i.name.toLowerCase().includes(kw)) : c.items,
    }))
    .filter((c) => c.items.length > 0);
});

const totalShown = computed(() => filtered.value.reduce((n, c) => n + c.items.length, 0));

/* -------- 详情抽屉 -------- */
const drawerCode = ref('');
const drawerName = ref('');
const drawerOpen = ref(false);

function openDetail(item: MenuCard) {
  drawerCode.value = item.code;
  drawerName.value = item.name;
  drawerOpen.value = true;
}

function switchBeType(v: 1 | 5) {
  beType.value = v;
  activeCat.value = '';
  void f.reload();
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>门店菜单</h2>
        <p class="panel-sub">
          {{ f.data.value?.storeName || '当前门店' }} · 共 {{ menu?.total ?? 0 }} 个在售餐品，{{ menu?.categories.length ?? 0 }} 个分类
        </p>
      </div>
    </div>

    <!-- 取餐方式 -->
    <div class="toolbar">
      <div class="chips">
        <button class="chip" :class="{ on: beType === 1 }" type="button" @click="switchBeType(1)">到店取餐</button>
        <button class="chip" :class="{ on: beType === 5 }" type="button" @click="switchBeType(5)">外送</button>
      </div>
      <input v-model="q" class="input search" type="text" placeholder="搜单品，比如 麦辣 / 巨无霸" />
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
    </div>

    <!-- 常点 -->
    <section v-if="menu?.frequent.length" class="freq">
      <h3 class="sec">常点</h3>
      <div class="freq-list">
        <button
          v-for="it in menu.frequent"
          :key="it.code"
          class="freq-item"
          type="button"
          @click="openDetail(it)"
        >
          <span class="fi-name">{{ it.name }}</span>
          <span class="fi-price">{{ money(it.price) }}</span>
        </button>
      </div>
    </section>

    <!-- 分类切换 -->
    <div v-if="menu" class="cats">
      <button class="chip" :class="{ on: activeCat === '' }" type="button" @click="activeCat = ''">
        全部 {{ allItems.length }}
      </button>
      <button
        v-for="c in menu.categories"
        :key="c.name"
        class="chip"
        :class="{ on: activeCat === c.name }"
        type="button"
        @click="activeCat = c.name"
      >
        {{ c.name }} {{ c.items.length }}
      </button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && totalShown === 0"
      empty-title="这个条件下没有餐品"
      :empty-text="q ? `「${q}」没搜到，换个词试试` : '门店可能还没开始供应，或者当前取餐方式下没有在售商品'"
      :skeleton-rows="6"
      @retry="f.reload"
    >
      <div v-for="c in filtered" :key="c.name" class="cat-block">
        <h3 class="sec">{{ c.name }} <span class="sec-count">{{ c.items.length }}</span></h3>
        <div class="items">
          <button
            v-for="it in c.items"
            :key="it.code"
            class="mi"
            :class="{ off: !it.available }"
            type="button"
            @click="openDetail(it)"
          >
            <img v-if="it.image" :src="it.image" :alt="it.name" class="mi-img" loading="lazy" />
            <div v-else class="mi-img mi-img-ph">M</div>
            <div class="mi-body">
              <span class="mi-name">{{ it.name }}</span>
              <span v-if="it.tags.length" class="mi-tags">
                <span v-for="t in it.tags" :key="t" class="tag gray">{{ t }}</span>
              </span>
            </div>
            <div class="mi-prices">
              <b>{{ money(it.price) }}</b>
              <span v-if="it.originalPrice && it.originalPrice > it.price" class="mi-orig">
                {{ money(it.originalPrice) }}
              </span>
            </div>
          </button>
        </div>
      </div>
    </AsyncBlock>

    <MealDrawer v-model:open="drawerOpen" :code="drawerCode" :fallback-name="drawerName" />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.search {
  flex: 1;
  min-width: 180px;
  max-width: 320px;
}

.sec {
  font-size: 13px;
  font-weight: 800;
  margin: 18px 0 9px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.sec-count {
  font-size: 10.5px;
  color: var(--ink-3);
  font-weight: 700;
  font-family: 'SF Mono', Consolas, monospace;
}

.freq {
  margin-bottom: 4px;
}
.freq-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.freq-item {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  border: 1.5px solid var(--yellow);
  background: var(--yellow-soft);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12.5px;
  transition: transform 0.15s;
}
.freq-item:hover {
  transform: translateY(-1px);
}
.fi-name {
  font-weight: 700;
}
.fi-price {
  color: var(--red-dark);
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
}

.cats {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin: 14px 0 4px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 10px;
}

.mi {
  display: flex;
  align-items: center;
  gap: 11px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 13px;
  text-align: left;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.mi:hover {
  border-color: var(--yellow);
  box-shadow: var(--shadow);
}
.mi.off {
  opacity: 0.5;
}
.mi-img {
  width: 46px;
  height: 46px;
  border-radius: 9px;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--yellow-soft);
}
.mi-img-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  font-weight: 900;
  color: var(--red);
  opacity: 0.5;
}
.mi-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mi-name {
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.mi-tags .tag {
  font-size: 10px;
  padding: 0 5px;
}
.mi-prices {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}
.mi-prices b {
  font-size: 13.5px;
  color: var(--red-dark);
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
}
.mi-orig {
  font-size: 10.5px;
  color: var(--ink-3);
  text-decoration: line-through;
}
</style>
