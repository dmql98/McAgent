<script setup lang="ts">
/**
 * 数据状态标记
 *
 * 普通页面上不展示接口名，只说明「数据是现查的还是缓存的、耗时多少」；
 * 把鼠标放上去才显示服务名。工具台里（显式要求技术细节）可点开看原始返回。
 */
import { computed } from 'vue';
import type { BlockMeta } from '../types';
import { ms as fmtMs } from '../lib/format';

const props = defineProps<{
  meta: BlockMeta | null | undefined;
  /** 显示耗时 */
  showCost?: boolean;
  /** 显示原始返回按钮 */
  showRaw?: boolean;
  /** 显示服务名（工具台等开发者场景） */
  technical?: boolean;
}>();

const emit = defineEmits<{ raw: [meta: BlockMeta] }>();

const kind = computed(() => {
  const s = props.meta?.source;
  if (s === 'mcp') return 'mcp';
  if (s === 'cache') return 'cache';
  if (s === 'empty') return 'empty';
  return '';
});

const label = computed(() => {
  const m = props.meta;
  if (!m) return '';
  if (m.source === 'empty') return '暂无数据';
  const base = props.technical ? m.tool : m.title || m.tool;
  if (m.source === 'cache') return `${base} · 缓存`;
  return base;
});

/** 悬停给出完整解释，不占界面空间 */
const title = computed(() => {
  const m = props.meta;
  if (!m) return '';
  const parts: string[] = [];
  parts.push(`数据：${m.title}`);
  if (props.technical) parts.push(`服务：${m.tool}`);
  parts.push(
    m.source === 'mcp'
      ? `本次实时获取，用时 ${fmtMs(m.costMs)}`
      : m.source === 'cache'
        ? '使用最近的查询结果，所以更快'
        : '查询完成，但没有返回可展示的内容',
  );
  if (m.reason) parts.push(`原因：${m.reason}`);
  return parts.join('\n');
});

const costText = computed(() => (props.meta ? fmtMs(props.meta.costMs) : ''));

function onClick() {
  if (!props.meta) return;
  if (props.showRaw) emit('raw', props.meta);
}
</script>

<template>
  <span v-if="meta" class="src-wrap">
    <button
      type="button"
      class="src"
      :class="[kind, { static: !showRaw }]"
      :title="title"
      :aria-label="title"
      @click="onClick"
    >
      {{ label }}
    </button>
    <span v-if="showCost && meta.source !== 'empty'" class="src-cost">{{ costText }}</span>
    <span v-if="meta.source === 'empty' && meta.reason" class="src-reason">{{ meta.reason }}</span>
  </span>
</template>

<style scoped>
.src-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.src {
  border: 1px solid transparent;
  background: rgba(43, 33, 24, 0.045);
  color: var(--ink-3);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  cursor: default;
  white-space: nowrap;
}
.src::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
  background: var(--ink-3);
}
.src.mcp {
  background: var(--green-soft);
  color: var(--green);
}
.src.mcp::before {
  background: var(--green);
}
.src.cache {
  background: var(--blue-soft);
  color: var(--blue);
}
.src.cache::before {
  background: var(--blue);
}
.src.empty {
  background: #FBF1EF;
  color: #9E5147;
}
.src.empty::before {
  background: #C87A6C;
}
.src:not(.static) {
  cursor: pointer;
}
.src:not(.static):hover {
  filter: brightness(0.97);
}
.src-cost {
  font-size: 10.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.src-reason {
  font-size: 10.5px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 34ch;
}
</style>
