<script setup lang="ts">
/**
 * 餐品详情抽屉
 *
 * 专门呈现 MCP 里最复杂的那块数据：特制项三层嵌套
 *   rounds[]（第几轮）→ choices[]（选什么）→ options[]（具体值，含加价）
 * 以及套餐组成 combo[]。
 *
 * 这是「把 MCP 展现出来」最典型的一处：旧前端完全没有这块，
 * 而它恰恰是真实数据结构最有料的地方。
 */
import { computed, watch } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import AsyncBlock from './AsyncBlock.vue';
import SourceBadge from './SourceBadge.vue';

const props = defineProps<{
  open: boolean;
  code: string;
  fallbackName?: string;
}>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const f = useFetch(
  () => (props.code ? api.mealDetail(props.code) : Promise.resolve(null)),
  { immediate: false },
);

watch(
  () => [props.open, props.code] as const,
  ([isOpen, code]) => {
    if (isOpen && code) void f.reload();
  },
);

const detail = computed(() => f.data.value?.data);
const meta = computed(() => f.data.value?.meta);

/** 特制项轮次：只展示有选项的，纯文本轮次折叠掉 */
const rounds = computed(() => (detail.value?.rounds ?? []).filter((r) => r.choices.length > 0));

function close() {
  emit('update:open', false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-mask" @click.self="close">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="餐品详情">
        <header class="d-head">
          <div class="d-title">
            <h3>{{ detail?.name || fallbackName || '餐品详情' }}</h3>
            <SourceBadge v-if="meta" :meta="meta" show-cost />
          </div>
          <button class="d-close" type="button" aria-label="关闭" @click="close"><AppIcon name="close" :size="16" /></button>
        </header>

        <div class="d-body">
          <AsyncBlock
            :loading="f.loading.value"
            :error="f.error.value"
            :empty="!f.loading.value && !f.error.value && !detail"
            empty-title="没能加载餐品详情"
            empty-text="可能这个餐品当前门店不供应"
            :skeleton-rows="4"
            @retry="f.reload"
          >
            <template v-if="detail">
              <div class="d-top">
                <img v-if="detail.image" :src="detail.image" :alt="detail.name" class="d-img" />
                <div v-else class="d-img d-img-ph">M</div>
                <div class="d-top-body">
                  <p v-if="detail.description" class="d-desc">{{ detail.description }}</p>
                  <div class="d-flags">
                    <span class="tag" :class="detail.supportModify ? 'green' : 'gray'">
                      {{ detail.supportModify ? '支持特制' : '不支持特制' }}
                    </span>
                    <span class="tag gray mono">code {{ detail.code }}</span>
                  </div>
                </div>
              </div>

              <!-- 套餐组成 -->
              <section v-if="detail.combo.length" class="d-sec">
                <h4>套餐组成</h4>
                <div class="combo">
                  <div v-for="(c, i) in detail.combo" :key="i" class="combo-item">
                    <img v-if="c.image" :src="c.image" :alt="c.name" class="combo-img" loading="lazy" />
                    <div v-else class="combo-img combo-img-ph">·</div>
                    <span class="combo-name">{{ c.name }}</span>
                    <span v-if="c.quantity && c.quantity > 1" class="combo-qty">×{{ c.quantity }}</span>
                  </div>
                </div>
              </section>

              <!-- 特制项：三层嵌套 -->
              <section v-if="rounds.length" class="d-sec">
                <h4>可选配料与规格 <span class="hint-mark">可调整口味、份量和加料</span></h4>
                <div v-for="(r, ri) in rounds" :key="ri" class="round">
                  <div class="round-head">
                    <span class="round-idx">第 {{ ri + 1 }} 轮</span>
                    <b>{{ r.name }}</b>
                  </div>
                  <div class="choices">
                    <div v-for="(c, ci) in r.choices" :key="ci" class="choice" :class="{ def: c.isDefault }">
                      <div class="ch-head">
                        <span class="ch-name">{{ c.name }}</span>
                        <span v-if="c.isDefault" class="tag green">默认</span>
                        <span v-if="c.diffPrice" class="ch-diff">{{ c.diffPrice }}</span>
                      </div>
                      <div v-if="c.options.length" class="opts">
                        <span v-for="(o, oi) in c.options" :key="oi" class="opt" :class="{ def: o.default }">
                          {{ o.name }}
                          <em v-if="o.diffPrice">{{ o.diffPrice }}</em>
                        </span>
                      </div>
                      <p v-else class="ch-note">{{ c.supportModify ? '支持修改（无子选项）' : '不可修改' }}</p>
                    </div>
                  </div>
                </div>
              </section>

              <p v-if="!detail.combo.length && !rounds.length" class="d-none">
                这个餐品没有套餐组成也没有特制项 —— 就是一个标准单品。
              </p>
            </template>
          </AsyncBlock>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(43, 33, 24, 0.4);
  z-index: 300;
  display: flex;
  justify-content: flex-end;
  animation: fade 0.2s ease;
}
@keyframes fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.drawer {
  width: 460px;
  max-width: 94vw;
  height: 100%;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  box-shadow: -12px 0 40px rgba(43, 33, 24, 0.2);
  animation: slide 0.26s cubic-bezier(0.32, 0.72, 0, 1);
}
@keyframes slide {
  from {
    transform: translateX(100%);
  }
  to {
    transform: none;
  }
}

.d-head {
  flex-shrink: 0;
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 14px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.d-title h3 {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.2px;
  margin-bottom: 5px;
}
.d-close {
  border: none;
  background: transparent;
  font-size: 17px;
  color: var(--ink-3);
  padding: 2px 6px;
  border-radius: 7px;
  line-height: 1;
  flex-shrink: 0;
}
.d-close:hover {
  background: #FFF1EF;
  color: var(--red);
}

.d-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 30px;
}

.d-top {
  display: flex;
  gap: 13px;
  margin-bottom: 18px;
}
.d-img {
  width: 84px;
  height: 84px;
  border-radius: 12px;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--yellow-soft);
}
.d-img-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 900;
  color: var(--red);
  opacity: 0.35;
}
.d-top-body {
  flex: 1;
  min-width: 0;
}
.d-desc {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.7;
}
.d-flags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.mono {
  font-family: 'SF Mono', Consolas, monospace;
}

.d-sec {
  margin-bottom: 20px;
}
.d-sec h4 {
  font-size: 12.5px;
  font-weight: 800;
  color: var(--ink);
  margin-bottom: 10px;
}
.hint-mark {
  font-weight: 400;
  font-size: 10.5px;
  color: var(--ink-3);
  display: block;
  margin-top: 2px;
}

.combo {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.combo-item {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 11px;
  font-size: 12.5px;
}
.combo-img {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--yellow-soft);
  flex-shrink: 0;
}
.combo-img-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
}
.combo-name {
  flex: 1;
  font-weight: 600;
}
.combo-qty {
  color: var(--red-dark);
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 11.5px;
}

.round {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 10px;
}
.round-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
.round-idx {
  font-size: 10px;
  font-weight: 800;
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 5px;
  padding: 1px 6px;
  color: var(--ink);
  flex-shrink: 0;
}
.round-head b {
  font-size: 12.5px;
}

.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.choice {
  border-left: 2px solid var(--line);
  padding-left: 10px;
}
.choice.def {
  border-left-color: var(--yellow);
}
.ch-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.ch-name {
  font-size: 12.5px;
  font-weight: 700;
}
.ch-diff {
  font-size: 11px;
  color: var(--red-dark);
  font-family: 'SF Mono', Consolas, monospace;
  font-weight: 700;
}
.opts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.opt {
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--ink-2);
  background: #FEFCF9;
}
.opt.def {
  border-color: var(--yellow);
  background: var(--yellow-soft);
  color: var(--ink);
  font-weight: 700;
}
.opt em {
  font-style: normal;
  color: var(--red-dark);
  font-weight: 700;
  margin-left: 3px;
}
.ch-note {
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 4px;
}

.d-none {
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.7;
  text-align: center;
  padding: 20px 10px;
}
</style>
