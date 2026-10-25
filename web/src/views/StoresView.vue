<script setup lang="ts">
/**
 * 找门店
 *
 * 对应工具：query-nearby-stores（+ query-store-detail / now-time-info 辅助）
 * 麦当劳查门店只接受「城市 + 关键词」，不认经纬度 —— 所以搜索框的城市是主输入。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { store } from '../store';
import { useFetch } from '../lib/useFetch';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';

const city = ref(store.state.location?.searchCity ?? '');
const keyword = ref(store.state.location?.searchKeyword ?? '');
const beType = ref<1 | 5>(1);

const f = useFetch(() =>
  api.stores({
    ...(city.value.trim() ? { city: city.value.trim() } : {}),
    ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    beType: beType.value,
  }),
);

const stores = computed(() => f.data.value?.data ?? []);

function search() {
  void f.reload();
}

/** 把这个门店设为当前门店（写进记忆，影响菜单/券的价格上下文） */
async function useAsCurrent(s: { storeCode: string; name: string; city?: string }) {
  try {
    // 定位接口存的是「城市 + 商圈」，用门店名当关键词最容易命中
    await api.submitLocation({
      lat: 22.5431,
      lng: 114.0579,
      ...(s.city || city.value ? { city: s.city || city.value } : {}),
      district: s.name,
      source: 'manual',
    });
    await store.refreshLocation();
    void store.refreshMemory(true);
    toast(`当前门店改成：${s.name}`);
    void f.reload();
  } catch (e) {
    toast(messageOf(e), true);
  }
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>找门店</h2>
        <p class="panel-sub">
          输入城市，可按商圈、地标或店名查找门店。
        </p>
      </div>
    </div>

    <!-- 搜索条件 -->
    <div class="search-bar">
      <input v-model="city" class="input" type="text" placeholder="城市，比如 深圳市" @keydown.enter="search" />
      <input v-model="keyword" class="input" type="text" placeholder="商圈 / 地标 / 店名（可不填）" @keydown.enter="search" />
      <select v-model.number="beType" class="input select" @change="search">
        <option :value="1">到店取餐</option>
        <option :value="5">外送</option>
      </select>
      <button class="btn btn-primary" type="button" :disabled="f.loading.value" @click="search">
        {{ f.loading.value ? '查询中…' : '查门店' }}
      </button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && stores.length === 0"
      empty-title="这个条件下没查到门店"
      :empty-text="city ? `试试换一个城市，或者把关键词清空（现在是「${city}」）` : '先填个城市，比如「深圳市」'"
      :skeleton-rows="4"
      @retry="f.reload"
    >
      <div class="stack">
        <article v-for="s in stores" :key="s.storeCode" class="store">
          <div class="store-head">
            <div class="store-title">
              <h3>{{ s.name }}</h3>
              <span v-if="s.businessStatus" class="tag" :class="s.open === false ? 'gray' : 'green'">
                {{ s.businessStatus }}
              </span>
              <span v-if="s.reservation" class="tag red">可预约</span>
            </div>
            <span v-if="s.distanceText" class="store-dist">{{ s.distanceText }}</span>
          </div>

          <p v-if="s.address" class="store-addr">{{ s.address }}</p>

          <div class="store-meta">
            <span v-if="s.businessHours" class="sm-item"><AppIcon name="clock" :size="12" /> {{ s.businessHours }}</span>
            <span v-if="s.city" class="sm-item"><AppIcon name="city" :size="12" /> {{ s.city }}</span>
          </div>

          <div v-if="s.tags.length" class="store-tags">
            <span v-for="t in s.tags" :key="t" class="tag gray">{{ t }}</span>
          </div>

          <div v-if="s.reservationOptions?.length" class="store-resv">
            可约：{{ s.reservationOptions.join('、') }}
          </div>

          <div class="store-acts">
            <button class="btn btn-soft btn-sm" type="button" @click="useAsCurrent(s)">设为当前门店</button>
            <router-link class="btn btn-ghost btn-sm" :to="{ name: 'menu' }">看这家店的菜单</router-link>
          </div>
        </article>
      </div>
    </AsyncBlock>

    <p class="foot-note">选择门店后，可查看该店菜单。</p>
  </div>
</template>

<style scoped>
.search-bar {
  display: grid;
  grid-template-columns: 1fr 1.3fr 130px auto;
  gap: 9px;
  margin-bottom: 16px;
}
@media (max-width: 820px) {
  .search-bar {
    grid-template-columns: 1fr;
  }
}
.select {
  cursor: pointer;
}

.store {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 15px 17px;
  transition: border-color 0.18s;
}
.store:hover {
  border-color: var(--yellow);
}
.store-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.store-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.store-title h3 {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.2px;
}
.store-dist {
  font-size: 12px;
  color: var(--red-dark);
  font-weight: 800;
  flex-shrink: 0;
  font-family: 'SF Mono', Consolas, monospace;
}
.store-addr {
  font-size: 12.5px;
  color: var(--ink-2);
  margin-top: 6px;
  line-height: 1.6;
}
.store-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--ink-3);
}
.sm-item.mono {
  font-family: 'SF Mono', Consolas, monospace;
}
.store-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 9px;
}
.store-resv {
  font-size: 11.5px;
  color: var(--green);
  margin-top: 8px;
  background: var(--green-soft);
  border-radius: 7px;
  padding: 5px 10px;
  display: inline-block;
}
.store-acts {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.store-acts a {
  text-decoration: none;
}

.foot-note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}
</style>
