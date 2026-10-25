<script setup lang="ts">
/**
 * 营养表
 *
 * 对应工具：list-nutrition-foods（160 条）
 * 服务端用 TOON 紧凑表返回，后端已归一化成 NutritionRow[]。
 * 这里做的是「让它可读」：按热量排序看最重的几个、支持搜索、完整表格。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import AsyncBlock from '../components/AsyncBlock.vue';

const q = ref('');
const sortBy = ref<'energyKcal' | 'protein' | 'fat' | 'sodium'>('energyKcal');

const f = useFetch(() => api.nutrition());

const data = computed(() => f.data.value);
const rows = computed(() => data.value?.rows ?? []);

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  const list = kw ? rows.value.filter((r) => r.productName.toLowerCase().includes(kw)) : [...rows.value];
  const key = sortBy.value;
  return list.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
});

/** 展示前 40 条，避免 160 行一次铺满 */
const shown = computed(() => filtered.value.slice(0, 40));

const heaviest = computed(() => data.value?.heaviest ?? []);

function n(v: number | undefined, unit = ''): string {
  if (v === undefined || v === null) return '—';
  return `${v}${unit}`;
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>营养表</h2>
        <p class="panel-sub">
          共 {{ data?.total ?? 0 }} 条餐品营养信息，可搜索并按热量、蛋白质等排序。
        </p>
      </div>
    </div>

    <!-- 热量最高的几个 -->
    <section v-if="heaviest.length" class="top-section">
      <h3 class="sec">热量最高的 {{ heaviest.length }} 个</h3>
      <div class="heat-list">
        <div v-for="(r, i) in heaviest" :key="r.productName" class="heat-item">
          <span class="hi-rank">{{ i + 1 }}</span>
          <span class="hi-name">{{ r.productName }}</span>
          <span class="hi-bar">
            <i :style="{ width: `${((r.energyKcal ?? 0) / (heaviest[0]?.energyKcal || 1)) * 100}%` }" />
          </span>
          <b class="hi-kcal">{{ r.energyKcal ?? '—' }} kcal</b>
        </div>
      </div>
    </section>

    <!-- 搜索 + 排序 -->
    <div class="toolbar">
      <input v-model="q" class="input search" type="text" placeholder="搜餐品名，比如 巨无霸" />
      <select v-model="sortBy" class="input select">
        <option value="energyKcal">按热量</option>
        <option value="protein">按蛋白质</option>
        <option value="fat">按脂肪</option>
        <option value="sodium">按钠</option>
      </select>
      <span class="count">{{ filtered.length }} 条</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && filtered.length === 0"
      empty-title="没查到营养数据"
      :empty-text="q ? `没有找到与「${q}」相关的餐品` : '暂时没有可用的营养信息，请稍后刷新'"
      :skeleton-rows="8"
      @retry="f.reload"
    >
      <div class="table-wrap">
        <table class="nt">
          <thead>
            <tr>
              <th class="w-name">餐品</th>
              <th>热量</th>
              <th>千焦</th>
              <th>蛋白质</th>
              <th>脂肪</th>
              <th>碳水</th>
              <th>钠</th>
              <th>钙</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.productName">
              <td class="w-name">
                <b>{{ r.productName }}</b>
                <span v-if="r.nutritionDescription" class="nt-desc">{{ r.nutritionDescription }}</span>
              </td>
              <td class="num kcal">{{ n(r.energyKcal) }}</td>
              <td class="num">{{ n(r.energyKj) }}</td>
              <td class="num">{{ n(r.protein, 'g') }}</td>
              <td class="num">{{ n(r.fat, 'g') }}</td>
              <td class="num">{{ n(r.carbohydrate, 'g') }}</td>
              <td class="num">{{ n(r.sodium, 'mg') }}</td>
              <td class="num">{{ n(r.calcium, 'mg') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="filtered.length > shown.length" class="more-note">
        只显示前 {{ shown.length }} 条（按{{ sortBy === 'energyKcal' ? '热量' : '所选营养成分' }}降序），共 {{ filtered.length }} 条。
        可输入更具体的餐品名称缩小范围。
      </p>
    </AsyncBlock>
  </div>
</template>

<style scoped>
.top-section {
  margin-bottom: 6px;
}
.sec {
  font-size: 13px;
  font-weight: 800;
  margin: 18px 0 10px;
}
.heat-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.heat-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.hi-rank {
  width: 18px;
  text-align: right;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
  flex-shrink: 0;
}
.hi-name {
  width: 128px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.hi-bar {
  flex: 1;
  height: 6px;
  background: #F4EDE1;
  border-radius: 3px;
  overflow: hidden;
}
.hi-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--yellow), var(--red));
  border-radius: 3px;
}
.hi-kcal {
  width: 74px;
  text-align: right;
  flex-shrink: 0;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 11.5px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 14px 0;
  flex-wrap: wrap;
}
.search {
  flex: 1;
  min-width: 160px;
  max-width: 280px;
}
.select {
  max-width: 140px;
  cursor: pointer;
}
.count {
  font-size: 11.5px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
}
.nt {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 660px;
}
.nt th {
  text-align: left;
  padding: 10px 11px;
  font-weight: 800;
  color: var(--ink-2);
  border-bottom: 1px solid var(--line);
  background: #FEFCF7;
  white-space: nowrap;
  font-size: 11px;
  position: sticky;
  top: 0;
}
.nt td {
  padding: 9px 11px;
  border-bottom: 1px dashed var(--line);
  vertical-align: top;
}
.nt tr:last-child td {
  border-bottom: none;
}
.nt tbody tr:hover {
  background: #FEFCF7;
}
.w-name {
  min-width: 170px;
}
.w-name b {
  font-weight: 700;
  font-size: 12.5px;
}
.nt-desc {
  display: block;
  font-size: 10.5px;
  color: var(--ink-3);
  margin-top: 2px;
  line-height: 1.5;
}
.num {
  text-align: right;
  font-family: 'SF Mono', Consolas, monospace;
  color: var(--ink-2);
  white-space: nowrap;
}
.num.kcal {
  color: var(--red-dark);
  font-weight: 700;
}

.more-note {
  margin-top: 11px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}
</style>
