<script setup lang="ts">
/**
 * 价格试算
 *
 * 对应工具：calculate-price
 *
 * 这是唯一一个把「分」和「元」搞错就会出事的接口 ——
 * MCP 返回的金额单位是「分」，后端已除 100，这里直接用元。
 *
 * 同时它是最好的 MCP 演示：一按就真的打了一次麦当劳的算价接口，
 * 返回里连配送费、打包费、餐盒费都拆得清清楚楚。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { money } from '../lib/format';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';
import type { PriceBreakdown } from '../types';

interface Line {
  productCode: string;
  quantity: number;
}

const lines = ref<Line[]>([{ productCode: '', quantity: 1 }]);
const beType = ref(1);
const orderType = ref(1);

const busy = ref(false);
const result = ref<PriceBreakdown | null>(null);
const err = ref<unknown>(undefined);

/* -------- 从菜单挑商品 -------- */
const menu = ref<{ code: string; name: string; price: number }[]>([]);
const menuLoading = ref(false);
const menuErr = ref<unknown>(undefined);
const menuLoaded = ref(false);

async function loadMenu() {
  menuLoading.value = true;
  menuErr.value = undefined;
  try {
    const r = await api.explorerMenu();
    menu.value = r.data.categories.flatMap((c) => c.items).map((i) => ({ code: i.code, name: i.name, price: i.price }));
    menuLoaded.value = true;
  } catch (e) {
    menuErr.value = e;
  } finally {
    menuLoading.value = false;
  }
}
void loadMenu();

function addLine() {
  lines.value.push({ productCode: '', quantity: 1 });
}
function removeLine(i: number) {
  if (lines.value.length === 1) return;
  lines.value.splice(i, 1);
}

const valid = computed(() => lines.value.filter((l) => l.productCode.trim()).length > 0);

async function calc() {
  if (!valid.value) {
    toast('先填一个商品编码，或者从菜单里挑一个', true);
    return;
  }
  busy.value = true;
  err.value = undefined;
  try {
    const r = await api.price({
      beType: beType.value,
      orderType: orderType.value,
      items: lines.value.filter((l) => l.productCode.trim()).map((l) => ({
        productCode: l.productCode.trim(),
        quantity: Math.max(1, Math.min(50, l.quantity)),
      })),
    });
    result.value = r.data ?? null;
  } catch (e) {
    err.value = e;
  } finally {
    busy.value = false;
  }
}

const feeRows = computed(() => {
  const r = result.value;
  if (!r) return [];
  const rows: Array<[string, number | undefined]> = [
    ['商品合计', r.productTotal],
    ['配送费', r.deliveryFee],
    ['打包费', r.packingFee],
    ['餐盒费', r.tablewareFee],
    ['优惠', r.discount],
  ];
  return rows.filter((x): x is [string, number] => x[1] !== undefined && x[1] > 0);
});
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>价格试算</h2>
        <p class="panel-sub">
          选择餐品和数量，查看预计总价及费用明细。
        </p>
      </div>
    </div>

    <!-- 取餐方式 -->
    <div class="row-line">
      <div class="chips">
        <button class="chip" :class="{ on: beType === 1 }" type="button" @click="beType = 1">到店取餐</button>
        <button class="chip" :class="{ on: beType === 5 }" type="button" @click="beType = 5">外送</button>
      </div>
      <div class="chips">
        <button class="chip" :class="{ on: orderType === 1 }" type="button" @click="orderType = 1">立即取餐</button>
        <button class="chip" :class="{ on: orderType === 2 }" type="button" @click="orderType = 2">预约取餐</button>
      </div>
    </div>

    <!-- 商品行 -->
    <div class="lines">
      <div v-for="(l, i) in lines" :key="i" class="line">
        <select v-if="menuLoaded && menu.length" v-model="l.productCode" class="input line-code">
          <option value="">— 选一个商品 —</option>
          <option v-for="m in menu" :key="m.code" :value="m.code">{{ m.name }} · {{ money(m.price) }}</option>
        </select>
        <input v-else v-model="l.productCode" class="input line-code" type="text" placeholder="商品编码" />
        <input v-model.number="l.quantity" class="input line-qty" type="number" min="1" max="50" />
        <button class="line-del" type="button" :disabled="lines.length === 1" aria-label="删除这一行" @click="removeLine(i)">
          <AppIcon name="close" :size="14" />
        </button>
      </div>
      <div class="line-acts">
        <button class="btn btn-ghost btn-sm" type="button" @click="addLine">+ 再加一行</button>
        <button class="btn btn-primary" type="button" :disabled="busy || !valid" @click="calc">
          {{ busy ? '算价中…' : '算一下' }}
        </button>
      </div>
      <p v-if="menuErr" class="menu-err">菜单加载失败（{{ messageOf(menuErr) }}），可手动输入商品编码。</p>
      <p v-else-if="menuLoading" class="menu-hint">正在加载菜单…</p>
    </div>

    <!-- 结果 -->
    <AsyncBlock
      :loading="busy"
      :error="err"
      :empty="!busy && !err && !result"
      empty-title="暂无试算结果"
      empty-text="选好商品点「算一下」，这里会显示完整的金额拆分。"
      :skeleton-rows="4"
      @retry="calc"
    >
      <template v-if="result">
        <div class="result">
          <div class="res-head">
            <span class="res-label">应付</span>
            <b class="res-total">{{ money(result.total) }}</b>
            <span v-if="result.original && result.original > result.total" class="res-orig">
              原价 {{ money(result.original) }}
            </span>
          </div>

          <div v-if="feeRows.length" class="res-fees">
            <div v-for="[label, v] in feeRows" :key="label" class="fee-row">
              <span>{{ label }}</span>
              <b>{{ label === '优惠' ? `-${money(v)}` : money(v) }}</b>
            </div>
          </div>

          <div v-if="result.items.length" class="res-items">
            <h4>商品明细</h4>
            <div v-for="(it, i) in result.items" :key="i" class="ri">
              <span class="ri-name">{{ it.name || '所选餐品' }}</span>
              <span v-if="it.quantity" class="ri-qty">×{{ it.quantity }}</span>
              <span v-if="it.originalSubtotal && it.subtotal && it.originalSubtotal > it.subtotal" class="ri-orig">
                {{ money(it.originalSubtotal) }}
              </span>
              <b class="ri-sub">{{ it.subtotal !== undefined ? money(it.subtotal) : '—' }}</b>
            </div>
          </div>

          <div v-if="result.takeWays.length" class="res-ways">
            <h4>这个门店支持的取餐方式</h4>
            <div class="ways">
              <span v-for="w in result.takeWays" :key="w.code" class="tag">{{ w.title }}</span>
            </div>
          </div>
        </div>

        <p class="hint-final">
          试算金额供参考，最终价格以提交订单时为准。
        </p>
      </template>
    </AsyncBlock>
  </div>
</template>

<style scoped>
.row-line {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.lines {
  margin-bottom: 18px;
}
.line {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
.line-code {
  flex: 1;
  min-width: 0;
}
.line-qty {
  width: 82px;
  flex-shrink: 0;
  text-align: center;
}
.line-del {
  border: 1.5px solid var(--line);
  background: #fff;
  color: var(--ink-3);
  border-radius: 9px;
  width: 34px;
  height: 38px;
  flex-shrink: 0;
  font-size: 12px;
}
.line-del:hover:not(:disabled) {
  border-color: var(--red);
  color: var(--red);
}
.line-del:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.line-acts {
  display: flex;
  gap: 9px;
  align-items: center;
  flex-wrap: wrap;
}
.menu-hint,
.menu-err {
  font-size: 11.5px;
  color: var(--ink-3);
  margin-top: 8px;
}
.menu-err {
  color: var(--red-dark);
}

.result {
  background: var(--card);
  border: 1.5px solid var(--yellow);
  border-radius: var(--radius-lg);
  padding: 18px;
}
.res-head {
  display: flex;
  align-items: baseline;
  gap: 11px;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.res-label {
  font-size: 12px;
  color: var(--ink-2);
}
.res-total {
  font-size: 30px;
  font-weight: 900;
  color: var(--red-dark);
  letter-spacing: -1px;
  line-height: 1.1;
  font-family: 'SF Mono', Consolas, monospace;
}
.res-orig {
  font-size: 12px;
  color: var(--ink-3);
  text-decoration: line-through;
}

.res-fees {
  padding: 11px 0;
  border-bottom: 1px dashed var(--line);
}
.fee-row {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  padding: 3px 0;
  color: var(--ink-2);
}
.fee-row b {
  color: var(--ink);
  font-family: 'SF Mono', Consolas, monospace;
  font-weight: 700;
}

.res-items,
.res-ways {
  padding-top: 12px;
}
.res-items h4,
.res-ways h4 {
  font-size: 11.5px;
  font-weight: 800;
  color: var(--ink-2);
  margin-bottom: 8px;
}
.ri {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--line);
}
.ri:last-child {
  border-bottom: none;
}
.ri-name {
  flex: 1;
  min-width: 0;
}
.ri-qty {
  color: var(--ink-3);
  font-size: 11.5px;
  font-family: 'SF Mono', Consolas, monospace;
}
.ri-orig {
  color: var(--ink-3);
  font-size: 11px;
  text-decoration: line-through;
}
.ri-sub {
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
}

.ways {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.hint-final {
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}
</style>
