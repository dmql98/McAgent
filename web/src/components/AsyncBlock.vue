<script setup lang="ts">
/**
 * 异步区块统一包装。
 *
 * 每个面板的数据各自独立加载，都会有加载中 / 空 / 出错三种状态，
 * 统一成固定组件避免每页重复：
 *   loading  → 骨架
 *   error    → 错误 + 重试
 *   empty    → 空态说明
 *   default  → 内容
 */
import { codeOf, messageOf } from '../lib/error';

withDefaults(
  defineProps<{
    loading?: boolean;
    error?: unknown;
    /** 数据为空时显示（null/undefined/空数组都算空） */
    empty?: boolean;
    /** 空态标题 */
    emptyTitle?: string;
    /** 空态说明 */
    emptyText?: string;
    /** 骨架行数 */
    skeletonRows?: number;
    /** 紧凑模式：错误和空态用小尺寸 */
    compact?: boolean;
  }>(),
  {
    loading: false,
    error: undefined,
    empty: false,
    emptyTitle: '这里还没有数据',
    emptyText: '',
    skeletonRows: 3,
    compact: false,
  },
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <!-- 加载中 -->
  <div v-if="loading" class="sk-wrap" :class="{ compact }" aria-busy="true" aria-live="polite">
    <div v-for="i in skeletonRows" :key="i" class="skeleton sk-row" :style="{ width: `${100 - (i - 1) * 12}%` }" />
    <span class="sr-only">正在加载</span>
  </div>

  <!-- 出错 -->
  <div v-else-if="error" class="err-box" :class="{ compact }" role="alert">
    <template v-if="codeOf(error) === 'NEED_LOCATION'">
      <b>还没有设置位置</b>
      <p>门店查询需要城市和商圈信息。设置位置后，这个页面就会有内容。</p>
      <router-link class="btn btn-primary btn-sm" to="/memory">去设置位置</router-link>
    </template>
    <template v-else-if="codeOf(error) === 'TOKEN_INVALID' || codeOf(error) === 'UNAUTHORIZED'">
      <b>需要先登录</b>
      <p>{{ messageOf(error) }}。这个页面的数据属于你的麦当劳账户，登录后才能查看。</p>
      <router-link class="btn btn-primary btn-sm" to="/login">连接麦当劳账户</router-link>
    </template>
    <template v-else-if="codeOf(error) === 'RATE_LIMITED'">
      <b>操作太频繁</b>
      <p>{{ messageOf(error) }}。请稍等片刻再试。</p>
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('retry')">重试</button>
    </template>
    <template v-else>
      <b>{{ messageOf(error) }}</b>
      <p v-if="codeOf(error) === 'MCP_DOWN'">暂时无法连接麦当劳服务，请稍后重试。</p>
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('retry')">重试</button>
    </template>
  </div>

  <!-- 空 -->
  <div v-else-if="empty" class="empty-box" :class="{ compact }">
    <b>{{ emptyTitle }}</b>
    <slot name="empty">
      <span v-if="emptyText">{{ emptyText }}</span>
    </slot>
  </div>

  <!-- 内容 -->
  <slot v-else />
</template>

<style scoped>
.sk-wrap {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 4px 0;
}
.sk-row {
  height: 15px;
}
.sk-wrap.compact .sk-row {
  height: 11px;
}
.err-box.compact,
.empty-box.compact {
  padding: 12px 14px;
  font-size: 12px;
}
.err-box b {
  display: block;
  margin-bottom: 4px;
}
.err-box p {
  color: var(--ink-2);
  margin-bottom: 2px;
}
.empty-box b {
  display: block;
  color: var(--ink);
  font-size: 13px;
  margin-bottom: 4px;
}
</style>
