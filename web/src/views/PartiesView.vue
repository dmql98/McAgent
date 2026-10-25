<script setup lang="ts">
/**
 * 派对预约
 *
 * 对应工具链（四步依赖，必须按顺序走）：
 *   query-party-city → query-party-store → query-party-store-date → query-party-store-session
 * 最后 party-order-create（写操作）
 *
 * 这页是「把 MCP 展现出来」最能说明问题的例子：
 * 四个工具的依赖关系本身就是一条产品流程，旧前端完全看不到。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { money } from '../lib/format';
import AsyncBlock from '../components/AsyncBlock.vue';
import type { PartyCity, PartyDate, PartyProduct, PartySession, PartyStore } from '../types';

/** 每一步各自的状态 —— 依赖链没法用一个 loading 表达 */
const citiesLoading = ref(false);
const citiesErr = ref<unknown>(undefined);
const cities = ref<PartyCity[]>([]);

const storesLoading = ref(false);
const storesErr = ref<unknown>(undefined);
const stores = ref<PartyStore[]>([]);

const datesLoading = ref(false);
const datesErr = ref<unknown>(undefined);
const dates = ref<PartyDate[]>([]);

const sessionsLoading = ref(false);
const sessionsErr = ref<unknown>(undefined);
const sessions = ref<PartySession[]>([]);

/** 选中的路径 */
const city = ref<PartyCity | null>(null);
const store = ref<PartyStore | null>(null);
const pickedDate = ref<PartyDate | null>(null);

/** spuId 是这条链路的隐藏参数：不同派对商品对应不同的可约门店。
 *  它只能从积分商城里挑，所以这里直接拉一份派对类商品给人选，
 *  而不是让用户凭空填一串数字。 */
const spuIdText = ref('');
const spuId = computed(() => {
  const n = Number(spuIdText.value.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
});

const products = ref<PartyProduct[]>([]);
const productsLoading = ref(false);

async function loadProducts() {
  productsLoading.value = true;
  try {
    const r = await api.partyProducts();
    products.value = r.data ?? [];
    // 只有一个可选时直接选中，省一步点击
    if (products.value.length === 1 && products.value[0]!.spuId !== undefined) {
      spuIdText.value = String(products.value[0]!.spuId);
      await loadCities();
    }
  } catch {
    products.value = [];
  } finally {
    productsLoading.value = false;
  }
}

async function loadCities() {
  citiesLoading.value = true;
  citiesErr.value = undefined;
  try {
    const r = await api.parties(spuId.value);
    cities.value = r.cities.data;
  } catch (e) {
    citiesErr.value = e;
  } finally {
    citiesLoading.value = false;
  }
}
// 先拉派对商品；只有一个商品时 loadProducts 会顺手把城市也查了
void loadProducts();

async function pickCity(c: PartyCity) {
  city.value = c;
  store.value = null;
  pickedDate.value = null;
  stores.value = [];
  dates.value = [];
  sessions.value = [];

  storesLoading.value = true;
  storesErr.value = undefined;
  try {
    const r = await api.partyStores({
      code: c.code,
      ...(spuId.value !== undefined ? { spuId: spuId.value } : {}),
      ...(c.latitude !== undefined ? { lat: c.latitude } : {}),
      ...(c.longitude !== undefined ? { lng: c.longitude } : {}),
    });
    stores.value = r.data;
  } catch (e) {
    storesErr.value = e;
  } finally {
    storesLoading.value = false;
  }
}

async function pickStore(s: PartyStore) {
  store.value = s;
  pickedDate.value = null;
  dates.value = [];
  sessions.value = [];

  storesLoading.value = false;

  if (spuId.value === undefined) {
    datesErr.value = new Error('请先在上方选择派对商品，再查询可预约日期');
    return;
  }

  datesLoading.value = true;
  datesErr.value = undefined;
  try {
    const r = await api.partyDates({ storeCode: s.storeCode, spuId: spuId.value });
    dates.value = r.data;
  } catch (e) {
    datesErr.value = e;
  } finally {
    datesLoading.value = false;
  }
}

async function pickDate(d: PartyDate) {
  pickedDate.value = d;
  sessions.value = [];
  if (!store.value || spuId.value === undefined) return;

  sessionsLoading.value = true;
  sessionsErr.value = undefined;
  try {
    const r = await api.partySessions({
      storeCode: store.value.storeCode,
      spuId: spuId.value,
      dateStr: d.date,
    });
    sessions.value = r.data;
  } catch (e) {
    sessionsErr.value = e;
  } finally {
    sessionsLoading.value = false;
  }
}

const stepNow = computed(() => {
  if (!city.value) return 1;
  if (!store.value) return 2;
  if (!pickedDate.value) return 3;
  return 4;
});
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>派对预约</h2>
        <p class="panel-sub">
          选择派对商品，再按城市、门店和日期查询可预约场次。
        </p>
      </div>
      <div class="spu-box">
        <label>派对商品</label>
        <p v-if="productsLoading" class="spu-hint">正在从积分商城找派对商品…</p>
        <p v-else-if="products.length === 0" class="spu-hint">没找到派对类商品</p>
        <select v-else v-model="spuIdText" class="input" @change="loadCities">
          <option value="">请选择（必选）</option>
          <option v-for="p in products" :key="String(p.spuId)" :value="String(p.spuId)">
            {{ p.name }}{{ p.category ? ` · ${p.category}` : '' }}
          </option>
        </select>
      </div>
    </div>

    <!-- 步骤指示 -->
    <div class="steps">
      <div class="step" :class="{ on: stepNow === 1, done: stepNow > 1 }"><i>1</i>选城市</div>
      <div class="step-line" />
      <div class="step" :class="{ on: stepNow === 2, done: stepNow > 2 }"><i>2</i>选门店</div>
      <div class="step-line" />
      <div class="step" :class="{ on: stepNow === 3, done: stepNow > 3 }"><i>3</i>选日期</div>
      <div class="step-line" />
      <div class="step" :class="{ on: stepNow === 4 }"><i>4</i>选场次</div>
    </div>

    <!-- 1. 城市 -->
    <section class="stage">
      <header class="stage-head">
        <h3>① 有派对的城市</h3>
      </header>
      <AsyncBlock
        :loading="citiesLoading"
        :error="citiesErr"
        :empty="!citiesLoading && !citiesErr && cities.length === 0"
        empty-title="没有可预约的城市"
        empty-text="该派对商品暂无可预约城市，可尝试选择其他商品。"
        :skeleton-rows="2"
        @retry="loadCities"
      >
        <div class="city-list">
          <button
            v-for="c in cities"
            :key="c.code"
            class="city"
            :class="{ on: city?.code === c.code }"
            type="button"
            @click="pickCity(c)"
          >
            <b>{{ c.name }}</b>
          </button>
        </div>
      </AsyncBlock>
    </section>

    <!-- 2. 门店 -->
    <section v-if="city" class="stage">
      <header class="stage-head">
        <h3>② {{ city.name }} 的派对门店</h3>
      </header>
      <AsyncBlock
        :loading="storesLoading"
        :error="storesErr"
        :empty="!storesLoading && !storesErr && stores.length === 0"
        empty-title="这个城市没有可约门店"
        :skeleton-rows="2"
        @retry="pickCity(city)"
      >
        <div class="store-list">
          <button
            v-for="s in stores"
            :key="s.storeCode"
            class="pstore"
            :class="{ on: store?.storeCode === s.storeCode }"
            type="button"
            @click="pickStore(s)"
          >
            <div class="ps-body">
              <b>{{ s.name }}</b>
              <span v-if="s.address" class="ps-addr">{{ s.address }}</span>
            </div>
          </button>
        </div>
      </AsyncBlock>
    </section>

    <!-- 3. 日期 -->
    <section v-if="store" class="stage">
      <header class="stage-head">
        <h3>③ {{ store.name }} 可约日期</h3>
      </header>
      <div v-if="datesErr && spuId === undefined" class="err-box">
        <b>请先选择派对商品</b>
        <p>{{ (datesErr as Error).message }}</p>
      </div>
      <AsyncBlock
        v-else
        :loading="datesLoading"
        :error="datesErr"
        :empty="!datesLoading && !datesErr && dates.length === 0"
        empty-title="这家店暂时没有可约日期"
        :skeleton-rows="2"
        @retry="pickStore(store)"
      >
        <div class="date-list">
          <button
            v-for="d in dates"
            :key="d.date"
            class="date"
            :class="{ on: pickedDate?.date === d.date, off: d.available === false }"
            type="button"
            :disabled="d.available === false"
            @click="pickDate(d)"
          >
            <b>{{ d.date }}</b>
            <span v-if="d.weekday">{{ d.weekday }}</span>
            <span v-if="d.tag" class="tag">{{ d.tag }}</span>
          </button>
        </div>
      </AsyncBlock>
    </section>

    <!-- 4. 场次 -->
    <section v-if="pickedDate" class="stage">
      <header class="stage-head">
        <h3>④ {{ pickedDate.date }} 的场次</h3>
      </header>
      <AsyncBlock
        :loading="sessionsLoading"
        :error="sessionsErr"
        :empty="!sessionsLoading && !sessionsErr && sessions.length === 0"
        empty-title="这天没有场次了"
        :skeleton-rows="2"
        @retry="pickDate(pickedDate)"
      >
        <div class="sess-list">
          <div v-for="(s, i) in sessions" :key="i" class="sess">
            <div class="ss-body">
              <b>{{ s.name }}</b>
              <span v-if="s.startTime || s.endTime" class="ss-time">
                {{ s.startTime || '' }}{{ s.startTime && s.endTime ? ' - ' : '' }}{{ s.endTime || '' }}
              </span>
            </div>
            <div class="ss-right">
              <span v-if="s.price !== undefined" class="ss-price">{{ money(s.price) }}</span>
              <span v-if="s.stock !== undefined" class="ss-stock">剩 {{ s.stock }}</span>
              <span v-if="s.status" class="tag" :class="s.status.includes('满') ? 'gray' : 'green'">{{ s.status }}</span>
            </div>
          </div>
        </div>

        <div class="final-note">
          <b>下一步：下单</b>
          <p>
            本页用于查询可预约场次。如需预订，可前往对话点餐说明所选商品、门店、日期和场次，再确认订单。
          </p>
        </div>
      </AsyncBlock>
    </section>
  </div>
</template>

<style scoped>
.spu-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
}
.spu-box label {
  font-size: 10.5px;
  color: var(--ink-3);
}
.spu-box .input {
  padding: 7px 11px;
  font-size: 12.5px;
}

.steps {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 18px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
  flex-shrink: 0;
}
.step i {
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--line);
  color: var(--ink-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-style: normal;
  font-weight: 800;
}
.step.on {
  color: var(--red-dark);
  font-weight: 800;
}
.step.on i {
  background: var(--red);
  color: #fff;
}
.step.done i {
  background: var(--yellow);
  color: var(--ink);
}
.step-line {
  flex: 1;
  min-width: 14px;
  height: 1px;
  background: var(--line);
}

.stage {
  margin-bottom: 20px;
}
.stage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.stage-head h3 {
  font-size: 13px;
  font-weight: 800;
}

.city-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.city {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  border: 1.5px solid var(--line);
  background: var(--card);
  border-radius: 10px;
  padding: 8px 14px;
  transition: border-color 0.18s, background 0.18s;
}
.city:hover {
  border-color: var(--yellow);
}
.city.on {
  border-color: var(--red);
  background: #FFFCF8;
}
.city b {
  font-size: 13px;
  font-weight: 800;
}
.mono {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 10px;
  color: var(--ink-3);
}

.store-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pstore {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 14px;
  text-align: left;
  transition: border-color 0.18s;
}
.pstore:hover {
  border-color: var(--yellow);
}
.pstore.on {
  border-color: var(--red);
  background: #FFFCF8;
}
.ps-body {
  flex: 1;
  min-width: 0;
}
.ps-body b {
  font-size: 13px;
  font-weight: 700;
  display: block;
}
.ps-addr {
  font-size: 11px;
  color: var(--ink-3);
  display: block;
  margin-top: 2px;
}
.ps-code {
  flex-shrink: 0;
}

.date-list {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.date {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  border: 1.5px solid var(--line);
  background: var(--card);
  border-radius: 10px;
  padding: 8px 14px;
  min-width: 84px;
  transition: border-color 0.18s;
}
.date:hover:not(:disabled) {
  border-color: var(--yellow);
}
.date.on {
  border-color: var(--red);
  background: #FFFCF8;
}
.date.off {
  opacity: 0.45;
  cursor: not-allowed;
}
.date b {
  font-size: 12.5px;
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
}
.date span {
  font-size: 10.5px;
  color: var(--ink-3);
}

.sess-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sess {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 14px;
}
.ss-body {
  flex: 1;
  min-width: 0;
}
.ss-body b {
  font-size: 13px;
  font-weight: 700;
  display: block;
}
.ss-time {
  font-size: 11px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
}
.ss-right {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.ss-price {
  font-size: 13px;
  font-weight: 800;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
}
.ss-stock {
  font-size: 10.5px;
  color: var(--ink-3);
}

.final-note {
  margin-top: 14px;
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 10px;
  padding: 12px 14px;
}
.final-note b {
  font-size: 12.5px;
  color: var(--ink);
}
.final-note p {
  font-size: 11.5px;
  color: var(--ink-2);
  line-height: 1.7;
  margin-top: 4px;
}
</style>
