<script setup lang="ts">
/**
 * 应用主壳：左侧导航 + 顶栏 + 路由内容区
 *
 * 导航按用户点餐的实际路径分组（点餐 / 我的账户 / 更多服务），
 * 开发相关的工具台单独放在最后一组。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navByGroup } from './router-meta';
import { store } from './store';
import { api } from './api';
import ToastHost from './components/ToastHost.vue';
import AppIcon from './components/AppIcon.vue';
import type { AccountInfo } from './types';

const route = useRoute();
const router = useRouter();

const navOpen = ref(false);

/** 顶栏状态：门店 / 积分 */
const storeName = ref('');
const pointBalance = ref<number | null>(null);
const statusLoading = ref(false);

/** 只有登录页没有外壳 */
const showShell = computed(() => route.name !== 'login');

const navGroups = computed(() => navByGroup());

const currentTitle = computed(() => (route.meta.title as string) ?? '');

/** 聊天页要撑满高度、自己管滚动；其它页正常滚动 */
const isChat = computed(() => route.name === 'chat');

const activeName = computed(() => route.name as string);

watch(
  () => route.fullPath,
  () => {
    navOpen.value = false;
  },
);

async function loadStatus() {
  if (!store.state.me || store.state.guest) {
    storeName.value = '';
    pointBalance.value = null;
    return;
  }
  statusLoading.value = true;
  try {
    const ov = await api.overview();
    storeName.value = ov.store?.name ?? '';
    pointBalance.value = (ov.account?.data as AccountInfo | undefined)?.available ?? null;
  } catch {
    // 顶栏状态拉不到不影响主功能
  } finally {
    statusLoading.value = false;
  }
}

onMounted(() => {
  if (store.state.me && !store.state.guest) void loadStatus();
});

watch(
  () => store.state.me?.userId,
  () => void loadStatus(),
);

async function signOut() {
  await store.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <!-- 未登录：登录页自己占满全屏 -->
  <router-view v-if="!showShell" />

  <!-- 已登录：完整工作台 -->
  <div v-else class="shell">
    <!-- ---------------- 左侧导航 ---------------- -->
    <aside class="nav" :class="{ open: navOpen }">
      <div class="nav-brand">
        <div class="logo">M</div>
        <div class="nav-brand-text">
          <h1>麦门知己</h1>
          <p>点餐助手</p>
        </div>
      </div>

      <nav class="nav-scroll" aria-label="主导航">
        <template v-for="g in navGroups" :key="g.name">
          <p class="nav-group-label">{{ g.name }}</p>
          <router-link
            v-for="item in g.items"
            :key="item.name"
            :to="{ name: item.name }"
            class="nav-item"
            :class="{ on: activeName === item.name }"
          >
            <span class="ni-icon" aria-hidden="true"><AppIcon :name="item.icon" :size="15" /></span>
            <span class="ni-text">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>

      <div class="nav-foot">
        <div class="nav-user">
          <div class="avatar">{{ store.state.guest ? '访' : store.avatarChar.value }}</div>
          <div class="nav-user-info">
            <b>{{ store.displayName.value }}</b>
            <span>{{ store.state.guest ? '访客模式 · 每天 1 次' : store.state.me?.profile?.starSign || '已连接麦当劳账户' }}</span>
          </div>
          <button
            v-if="!store.state.guest"
            class="nav-signout"
            type="button"
            title="退出登录"
            aria-label="退出登录"
            @click="signOut"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>

    <div class="nav-backdrop" :class="{ open: navOpen }" @click="navOpen = false" />

    <!-- ---------------- 顶栏 ---------------- -->
    <header class="top">
      <button class="top-menu-btn" type="button" aria-label="打开导航" @click="navOpen = true">
        <AppIcon name="menu" :size="18" />
      </button>
      <div class="top-title">
        {{ currentTitle }}
        <span v-if="store.state.guest">试用中</span>
      </div>

      <div class="top-status">
        <router-link v-if="!store.state.guest" class="pill clickable hide-sm" to="/stores">
          <span class="pi" aria-hidden="true"><AppIcon name="pin" :size="14" /></span>
          <b>{{ storeName || (statusLoading ? '读取中…' : '未选门店') }}</b>
        </router-link>

        <router-link v-if="!store.state.guest" class="pill points clickable" to="/points">
          <span class="pi" aria-hidden="true"><AppIcon name="star" :size="14" /></span>
          <b>{{ pointBalance === null ? '—' : pointBalance }}</b>
          <span>积分</span>
        </router-link>

        <router-link v-if="!store.state.guest" class="pill hide-sm" to="/memory">
          <span class="pi" aria-hidden="true"><AppIcon name="user" :size="14" /></span>
          <b>偏好</b>
        </router-link>
      </div>
    </header>

    <!-- ---------------- 内容区 ---------------- -->
    <main class="main">
      <router-view v-slot="{ Component }">
        <component :is="Component" :class="isChat ? 'page-chat' : 'page'" />
      </router-view>
    </main>
  </div>

  <ToastHost />
</template>
