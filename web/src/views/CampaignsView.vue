<script setup lang="ts">
/**
 * 活动日历
 *
 * 对应工具：campaign-calendar
 *
 * 返回是 markdown 结构：`## 10月24日（今日）` + `### 活动标题` + 介绍 + <img>。
 * 后端按标题切分成 CampaignDay[]，这里按日期铺开。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';

const date = ref('');
const f = useFetch(() => api.campaigns(date.value.trim() || undefined));

const days = computed(() => f.data.value?.data ?? []);

/** 今天 / 往期 / 未来 三种标签的视觉区分 */
function labelClass(label?: string): string {
  if (!label) return 'gray';
  if (label.includes('今日') || label.includes('进行中')) return 'red';
  if (label.includes('往期')) return 'gray';
  return 'green';
}

function search() {
  void f.reload();
}
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>活动日历</h2>
        <p class="panel-sub">
          按日期查看近期活动和优惠信息。
        </p>
      </div>
    </div>

    <div class="toolbar">
      <input v-model="date" class="input search" type="date" @change="search" />
      <button class="btn btn-primary btn-sm" type="button" :disabled="f.loading.value" @click="search">查这天</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="((date = ''), search())">
        看最近
      </button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && days.length === 0"
      empty-title="这段时间没有活动"
      empty-text="换一天看看，或者清掉日期看最近的。"
      :skeleton-rows="3"
      @retry="f.reload()"
    >
      <div class="days">
        <section v-for="d in days" :key="d.date" class="day">
          <header class="day-head">
            <h3>{{ d.date }}</h3>
            <span v-if="d.label" class="tag" :class="labelClass(d.label)">{{ d.label }}</span>
            <span class="day-count">{{ d.activities.length }} 个活动</span>
          </header>

          <div class="acts">
            <article v-for="(a, i) in d.activities" :key="i" class="act">
              <img v-if="a.image" :src="a.image" :alt="a.title" class="a-img" loading="lazy" />
              <div class="a-body">
                <div class="a-title">
                  <b>{{ a.title }}</b>
                  <span v-for="t in a.tags" :key="t" class="tag gray">{{ t }}</span>
                </div>
                <p v-if="a.desc" class="a-desc">{{ a.desc }}</p>
                <span v-if="a.timeText" class="a-time"><AppIcon name="clock" :size="12" /> {{ a.timeText }}</span>
              </div>
            </article>
          </div>
        </section>
      </div>
    </AsyncBlock>

    <p class="note">
      活动时间和参与条件以活动详情为准。
    </p>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 9px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.search {
  max-width: 200px;
}

.days {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.day-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.day-head h3 {
  font-size: 15px;
  font-weight: 900;
  letter-spacing: -0.2px;
}
.day-count {
  font-size: 10.5px;
  color: var(--ink-3);
  margin-left: auto;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.act {
  display: flex;
  gap: 13px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 15px;
  transition: border-color 0.18s;
}
.act:hover {
  border-color: var(--yellow);
}
.a-img {
  width: 76px;
  height: 76px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--yellow-soft);
}
.a-body {
  flex: 1;
  min-width: 0;
}
.a-title {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.a-title b {
  font-size: 13.5px;
  font-weight: 800;
}
.a-desc {
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.7;
  margin-top: 5px;
}
.a-time {
  display: inline-block;
  font-size: 11px;
  color: var(--green);
  background: var(--green-soft);
  border-radius: 6px;
  padding: 2px 8px;
  margin-top: 7px;
}

.note {
  margin-top: 16px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}

@media (max-width: 560px) {
  .act {
    flex-direction: column;
  }
  .a-img {
    width: 100%;
    height: 130px;
  }
}
</style>
