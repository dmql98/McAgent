<script setup lang="ts">
/**
 * 外送地址
 *
 * 对应工具：delivery-query-addresses（读）、delivery-create-address（写）
 *
 * 读是安全的；建地址是写操作，必须显式确认 —— 这里同样走二次确认。
 */
import { computed } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import AsyncBlock from '../components/AsyncBlock.vue';

const f = useFetch(() => api.addresses());

const list = computed(() => f.data.value?.data ?? []);

function maskPhone(p?: string): string {
  if (!p) return '—';
  if (p.length < 7) return p;
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>外送地址</h2>
        <p class="panel-sub">
          查看麦当劳账号中已保存的外送地址。
        </p>
      </div>
      <div class="head-acts">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
      </div>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && list.length === 0"
      empty-title="还没有外送地址"
      empty-text="可在对话点餐页选择外送后添加地址，也可前往麦当劳 App 添加。"
      :skeleton-rows="2"
      @retry="f.reload()"
    >
      <div class="addrs">
        <article v-for="a in list" :key="a.addressId" class="addr">
          <div class="a-head">
            <b>{{ a.contactName || '未填联系人' }}</b>
            <span class="a-phone">{{ maskPhone(a.phone) }}</span>
            <span v-if="a.isDefault" class="tag green">默认</span>
            <span v-if="a.tag" class="tag">{{ a.tag }}</span>
            <span v-if="a.gender" class="tag gray">{{ a.gender }}</span>
          </div>
          <p class="a-line">
            <span v-if="a.city">{{ a.city }}</span>
            <span v-if="a.address">{{ a.address }}</span>
            <span v-if="a.detail">{{ a.detail }}</span>
          </p>
        </article>
      </div>
    </AsyncBlock>

    <p class="note">
      手机号已隐藏部分数字。修改已有地址请前往麦当劳 App。
    </p>
  </div>
</template>

<style scoped>
.head-acts {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.addrs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.addr {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 15px;
}
.a-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.a-head b {
  font-size: 13.5px;
  font-weight: 800;
}
.a-phone {
  font-size: 12px;
  color: var(--ink-2);
  font-family: 'SF Mono', Consolas, monospace;
}
.a-line {
  font-size: 12.5px;
  color: var(--ink-2);
  margin-top: 7px;
  line-height: 1.65;
}
.a-line span + span::before {
  content: ' · ';
  color: var(--ink-3);
}
.a-id {
  display: block;
  margin-top: 7px;
  font-size: 10.5px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
}

.note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}
</style>
