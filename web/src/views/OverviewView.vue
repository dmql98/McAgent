<script setup lang="ts">
/**
 * 总览面板
 *
 * 结构优先级：先给「现在能做什么」，再给「我有什么」，最后才是数据统计。
 * 接口层面的信息（工具数量、只读/写操作分布）折叠在页面底部的「开发信息」里，
 * 不影响普通点餐用户阅读。
 */
import { computed } from 'vue';
import { api } from '../api';
import { store } from '../store';
import { useFetch } from '../lib/useFetch';
import { thousands } from '../lib/format';
import AsyncBlock from '../components/AsyncBlock.vue';
import SourceBadge from '../components/SourceBadge.vue';
import AppIcon from '../components/AppIcon.vue';
import type { AccountInfo } from '../types';

const isGuest = computed(() => store.state.guest);

/** 访客没有账户数据，不必发这个请求，避免把 401 当错误弹出来 */
const f = useFetch(() => api.overview(), { immediate: !store.state.guest });

const ov = computed(() => f.data.value);

const account = computed(() => ov.value?.account?.data as AccountInfo | undefined);

const timeText = computed(() => {
  const t = ov.value?.time?.data;
  if (!t) return '';
  return t.formatted || t.datetime || '';
});

const greeting = computed(() => {
  const name = store.displayName.value;
  const h = new Date().getHours();
  const when = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${when}，${name}`;
});

/** 今天是不是还有券要过期 */
const expiring = computed(() => account.value?.expiringThisMonth ?? 0);

/** 首屏主入口：只放最常用的四个 */
const primaryActions = [
  {
    to: '/chat',
    icon: 'chat',
    title: '开始点餐',
    desc: '说人数、预算和口味，直接配一单',
    accent: true,
  },
  { to: '/menu', icon: 'burger', title: '看菜单', desc: '在售餐品、套餐与可选配料' },
  { to: '/coupons', icon: 'ticket', title: '我的券包', desc: '可用券与可领取的优惠' },
  { to: '/orders', icon: 'receipt', title: '订单记录', desc: '查看订单和当前进度' },
];

/** 次要服务 */
const moreLinks = [
  { to: '/stores', icon: 'pin', title: '找门店', desc: '按城市查门店和营业状态' },
  { to: '/nutrition', icon: 'leaf', title: '营养表', desc: '热量、蛋白质等成分' },
  { to: '/points', icon: 'star', title: '积分与抽奖', desc: '积分账户与抽奖活动' },
  { to: '/mall', icon: 'gift', title: '积分商城', desc: '用积分兑换商品' },
  { to: '/campaigns', icon: 'calendar', title: '活动日历', desc: '近期官方活动' },
  { to: '/parties', icon: 'sparkle', title: '派对预约', desc: '按门店和场次预约' },
];
</script>

<template>
  <div class="page-inner">
    <!-- 问候 + 主操作 -->
    <section class="hero">
      <div class="hero-main">
        <h1>{{ greeting }}</h1>
        <p v-if="ov?.store" class="hero-store">
          当前门店 <b>{{ ov.store.name }}</b>
          <span v-if="ov.store.city" class="muted">· {{ ov.store.city }}</span>
        </p>
        <p v-else class="hero-store muted">
          还没有选择门店
          <router-link to="/stores">去找门店</router-link>
          ，菜单和优惠会按门店显示。
        </p>
        <div class="hero-actions">
          <router-link class="btn btn-primary" to="/chat">开始点餐</router-link>
          <router-link class="btn btn-ghost" to="/stores">
            {{ ov?.store ? '换一家门店' : '选择门店' }}
          </router-link>
        </div>
      </div>

      <div v-if="timeText" class="hero-time">
        <span class="ht-label">门店当前时间</span>
        <b>{{ timeText }}</b>
        <SourceBadge v-if="ov?.time?.meta" :meta="ov.time.meta" />
      </div>
    </section>

    <!-- 主要入口 -->
    <div class="grid-4 entry-grid">
      <router-link
        v-for="a in primaryActions"
        :key="a.to"
        :to="a.to"
        class="entry"
        :class="{ accent: a.accent }"
      >
        <span class="entry-icon" aria-hidden="true"><AppIcon :name="a.icon" :size="20" /></span>
        <b>{{ a.title }}</b>
        <span class="entry-desc">{{ a.desc }}</span>
      </router-link>
    </div>

    <!-- 账户概览：访客没有账户数据，改成登录引导 -->
    <AsyncBlock
      v-if="!isGuest"
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :skeleton-rows="2"
      @retry="f.reload"
    >
      <div v-if="ov" class="grid-3 stat-row">
        <router-link class="stat" to="/points">
          <span class="st-label">可用积分</span>
          <b class="st-value">{{ account ? thousands(account.available) : '—' }}</b>
          <span v-if="expiring > 0" class="st-warn">本月有 {{ expiring }} 积分将过期</span>
          <span v-else class="st-sub">{{ account?.level || '麦当劳会员' }}</span>
          <SourceBadge v-if="ov.account?.meta" :meta="ov.account.meta" />
        </router-link>

        <router-link class="stat" to="/coupons">
          <span class="st-label">卡包优惠券</span>
          <b class="st-value">{{ ov.coupons.card }}</b>
          <span class="st-sub">还有 {{ ov.coupons.claimable }} 张可领取</span>
          <SourceBadge :meta="ov.coupons.cardBlock" />
        </router-link>

        <router-link class="stat" to="/menu">
          <span class="st-label">门店在售</span>
          <b class="st-value">{{ ov.menu.total }}</b>
          <span class="st-sub">共 {{ ov.menu.categories }} 个分类</span>
          <SourceBadge v-if="ov.menu.meta" :meta="ov.menu.meta" />
        </router-link>
      </div>
    </AsyncBlock>

    <!-- 访客：提示可体验的范围 -->
    <section v-else class="card guest-note">
      <b>当前是访客模式</b>
      <p>可以体验一次对话点餐。连接麦当劳账户后，可查看积分、优惠券和订单，并保存用餐偏好。</p>
      <router-link class="btn btn-soft btn-sm" to="/login">连接账户</router-link>
    </section>

    <!-- 已保存的偏好 -->
    <section v-if="!store.state.guest" class="card mem-summary">
      <div class="card-title">
        你的偏好
        <router-link class="btn-link" to="/memory" style="margin-left: auto">管理</router-link>
      </div>
      <p class="mem-note">点餐时会参考这些信息，也可以随时修改或删除。</p>
      <div class="ms-grid">
        <div class="ms-item">
          <span>忌口</span>
          <b :class="{ empty: !ov?.memory.taboo.length }">
            {{ ov?.memory.taboo.length ? ov.memory.taboo.join('、') : '未填写' }}
          </b>
        </div>
        <div class="ms-item">
          <span>常点</span>
          <b :class="{ empty: !ov?.memory.topItems.length }">
            {{ ov?.memory.topItems.length ? ov.memory.topItems.join('、') : '暂无记录' }}
          </b>
        </div>
        <div class="ms-item">
          <span>最近备注</span>
          <b :class="{ empty: !ov?.memory.moods.length }">
            {{ ov?.memory.moods.length ? ov.memory.moods.map((m) => m.mood).join('、') : '暂无记录' }}
          </b>
        </div>
      </div>
    </section>

    <!-- 更多服务 -->
    <h2 class="sec-title">更多服务</h2>
    <div class="grid-3 more-grid">
      <router-link v-for="q in moreLinks" :key="q.to" :to="q.to" class="more">
        <span class="q-icon" aria-hidden="true"><AppIcon :name="q.icon" :size="17" /></span>
        <span class="q-body">
          <b>{{ q.title }}</b>
          <span>{{ q.desc }}</span>
        </span>
      </router-link>
    </div>

    <!-- 开发信息：默认收起，不影响普通使用 -->
    <details v-if="ov" class="dev-info">
      <summary>开发信息</summary>
      <div class="dev-body">
        <div class="dev-line">
          <span>已接入 {{ ov.tools.total }} 项服务</span>
          <span class="dot-sep">·</span>
          <span>{{ ov.tools.readonly }} 项只读</span>
          <span class="dot-sep">·</span>
          <span>{{ ov.tools.write }} 项写操作</span>
          <router-link to="/tools" class="dev-link">打开工具台</router-link>
        </div>
        <div class="ts-bars">
          <div v-for="g in ov.tools.byGroup" :key="g.group" class="ts-row">
            <span class="ts-name">{{ g.group }}</span>
            <div class="ts-bar">
              <i :style="{ width: `${(g.count / ov.tools.total) * 100}%` }" />
            </div>
            <span class="ts-count">{{ g.count }}</span>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* ---------------- 问候区 ---------------- */

.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  background: linear-gradient(120deg, #fff 0%, #fffaf0 62%, #fff4d6 100%);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
  margin-bottom: 14px;
  box-shadow: var(--shadow-sm);
}
.hero-main h1 {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: -0.5px;
  line-height: 1.3;
}
.hero-store {
  font-size: 13px;
  color: var(--ink-2);
  margin-top: 6px;
}
.hero-store b {
  color: var(--ink);
  font-weight: 700;
}
.muted {
  color: var(--ink-3);
}
.hero-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.hero-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
  padding-left: 12px;
}
.ht-label {
  font-size: 11px;
  color: var(--ink-3);
}
.hero-time b {
  font-size: 14px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 主要入口 ---------------- */

.entry-grid {
  margin-bottom: 16px;
}
.entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 118px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 15px 16px;
  text-decoration: none;
  color: var(--ink);
  transition: border-color 0.18s, transform 0.18s, box-shadow 0.18s;
}
.entry:hover {
  border-color: var(--yellow);
  transform: translateY(-1px);
  box-shadow: var(--shadow);
}
.entry.accent {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}
.entry.accent:hover {
  background: var(--red-dark);
  border-color: var(--red-dark);
}
.entry-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--yellow-soft);
  color: var(--red-dark);
  margin-bottom: 6px;
}
.entry.accent .entry-icon {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.entry b {
  font-size: 14px;
  font-weight: 800;
}
.entry-desc {
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.5;
  margin-top: auto;
}
.entry.accent .entry-desc {
  color: rgba(255, 255, 255, 0.82);
}

/* ---------------- 账户概览 ---------------- */

.stat-row {
  margin-bottom: 16px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 15px 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-shadow: var(--shadow-sm);
  text-decoration: none;
  color: var(--ink);
  transition: border-color 0.18s, box-shadow 0.18s;
}
.stat:hover {
  border-color: var(--yellow);
  box-shadow: var(--shadow);
}
.st-label {
  font-size: 12px;
  color: var(--ink-2);
}
.st-value {
  font-size: 26px;
  font-weight: 900;
  line-height: 1.25;
  color: var(--ink);
  letter-spacing: -0.6px;
  font-variant-numeric: tabular-nums;
}
.st-sub {
  font-size: 11.5px;
  color: var(--ink-3);
}
.st-warn {
  font-size: 11.5px;
  color: var(--red);
  font-weight: 700;
}

/* ---------------- 访客提示 ---------------- */

.guest-note {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 16px;
  background: #FFFDF7;
}
.guest-note b {
  font-size: 13.5px;
  font-weight: 800;
}
.guest-note p {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.7;
}
.guest-note .btn {
  margin-top: 4px;
}

/* ---------------- 偏好 ---------------- */

.mem-summary {
  margin-bottom: 4px;
}
.mem-note {
  font-size: 12px;
  color: var(--ink-3);
  margin-top: 2px;
}
.ms-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 12px;
}
.ms-item span {
  display: block;
  font-size: 11px;
  color: var(--ink-3);
}
.ms-item b {
  display: block;
  font-size: 13px;
  font-weight: 700;
  margin-top: 3px;
  word-break: break-word;
}
.ms-item b.empty {
  color: var(--ink-3);
  font-weight: 500;
}
@media (max-width: 680px) {
  .ms-grid {
    grid-template-columns: 1fr;
  }
  .hero {
    padding: 18px;
  }
  .hero-main h1 {
    font-size: 20px;
  }
}

/* ---------------- 更多服务 ---------------- */

.sec-title {
  font-size: 15px;
  font-weight: 800;
  margin: 24px 0 10px;
}
.more-grid {
  margin-bottom: 8px;
}
.more {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 15px;
  text-decoration: none;
  color: var(--ink);
  transition: border-color 0.18s, box-shadow 0.18s;
}
.more:hover {
  border-color: var(--yellow);
  box-shadow: var(--shadow-sm);
}
.q-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: #FAF5EC;
  color: var(--ink-2);
  flex-shrink: 0;
}
.q-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.q-body b {
  font-size: 13px;
  font-weight: 700;
}
.q-body span {
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.5;
}

/* ---------------- 开发信息 ---------------- */

.dev-info {
  margin-top: 22px;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
.dev-info summary {
  font-size: 11.5px;
  color: var(--ink-3);
  cursor: pointer;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
  user-select: none;
}
.dev-info summary::-webkit-details-marker {
  display: none;
}
.dev-info summary::before {
  content: '›';
  display: inline-block;
  transition: transform 0.18s;
  font-size: 14px;
  line-height: 1;
}
.dev-info[open] summary::before {
  transform: rotate(90deg);
}
.dev-info summary:hover {
  color: var(--ink-2);
}
.dev-body {
  margin-top: 12px;
  background: #FEFCF7;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 15px;
}
.dev-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--ink-2);
}
.dot-sep {
  color: var(--ink-3);
}
.dev-link {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--red-dark);
}
.ts-bars {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ts-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
}
.ts-name {
  width: 70px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.ts-bar {
  flex: 1;
  height: 6px;
  background: #F1E8DA;
  border-radius: 4px;
  overflow: hidden;
}
.ts-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #FFD873, var(--red));
  border-radius: 4px;
  transition: width 0.4s ease;
}
.ts-count {
  width: 22px;
  text-align: right;
  font-weight: 700;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
