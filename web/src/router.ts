/**
 * 路由
 *
 * 用 hash 模式：
 * ① 生产环境 nginx 把 / 反代给 express，不需要额外配 try_files 回退；
 * ② 单页应用刷新任意面板都不会 404；
 * ③ 和旧版 #chat / #memory 的习惯保持连续。
 *
 * 面板划分依据：35 个 MCP 工具按能力域分组，每组至少一个可视图标。
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { store } from './store';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, title: '连接麦当劳' },
  },
  {
    path: '/onboard',
    name: 'onboard',
    component: () => import('./views/OnboardView.vue'),
    meta: { title: '设置用餐偏好' },
  },
  {
    path: '/',
    name: 'overview',
    component: () => import('./views/OverviewView.vue'),
    meta: { title: '总览', icon: '◎', nav: '总览', group: '点餐' },
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('./views/ChatView.vue'),
    meta: { title: '对话点餐', icon: '💬', nav: '对话点餐', group: '点餐', badge: 'chat' },
  },
  {
    path: '/memory',
    name: 'memory',
    component: () => import('./views/MemoryView.vue'),
    meta: { title: '偏好设置', icon: '🧠', nav: '偏好设置', group: '我的账户' },
  },

  /* ---- 定位门店（5 工具） ---- */
  {
    path: '/stores',
    name: 'stores',
    component: () => import('./views/StoresView.vue'),
    meta: { title: '找门店', icon: '📍', nav: '找门店', group: '点餐' },
  },

  /* ---- 菜单选品（5 工具） ---- */
  {
    path: '/menu',
    name: 'menu',
    component: () => import('./views/MenuView.vue'),
    meta: { title: '门店菜单', icon: '🍔', nav: '门店菜单', group: '点餐' },
  },
  {
    path: '/nutrition',
    name: 'nutrition',
    component: () => import('./views/NutritionView.vue'),
    meta: { title: '营养表', icon: '🥗', nav: '营养表', group: '点餐' },
  },

  /* ---- 优惠券（4 工具） ---- */
  {
    path: '/coupons',
    name: 'coupons',
    component: () => import('./views/CouponsView.vue'),
    meta: { title: '我的券包', icon: '🎟️', nav: '我的券包', group: '我的账户', badge: 'coupons' },
  },

  /* ---- 点餐交易（6 工具） ---- */
  {
    path: '/orders',
    name: 'orders',
    component: () => import('./views/OrdersView.vue'),
    meta: { title: '订单记录', icon: '🧾', nav: '订单记录', group: '我的账户' },
  },
  {
    path: '/cart',
    name: 'cart',
    component: () => import('./views/CartView.vue'),
    meta: { title: '价格试算', icon: '🧮', nav: '价格试算', group: '点餐' },
  },
  {
    path: '/addresses',
    name: 'addresses',
    component: () => import('./views/AddressesView.vue'),
    meta: { title: '外送地址', icon: '🏠', nav: '外送地址', group: '我的账户' },
  },

  /* ---- 积分商城（9 工具） ---- */
  {
    path: '/points',
    name: 'points',
    component: () => import('./views/PointsView.vue'),
    meta: { title: '积分与抽奖', icon: '⭐', nav: '积分与抽奖', group: '更多服务' },
  },
  {
    path: '/mall',
    name: 'mall',
    component: () => import('./views/MallView.vue'),
    meta: { title: '积分商城', icon: '🎁', nav: '积分商城', group: '更多服务' },
  },

  /* ---- 活动派对（6 工具） ---- */
  {
    path: '/campaigns',
    name: 'campaigns',
    component: () => import('./views/CampaignsView.vue'),
    meta: { title: '活动日历', icon: '📅', nav: '活动日历', group: '更多服务' },
  },
  {
    path: '/parties',
    name: 'parties',
    component: () => import('./views/PartiesView.vue'),
    meta: { title: '派对预约', icon: '🎉', nav: '派对预约', group: '更多服务' },
  },

  /* ---- 工具台（35 个工具全览 + 直调） ---- */
  {
    path: '/tools',
    name: 'tools',
    component: () => import('./views/ToolsView.vue'),
    meta: { title: '工具台', icon: '🛠️', nav: '工具台', group: '开发工具' },
  },

  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * 路由守卫
 *
 * 三条规则：
 * ① 启动没完成先等 —— 否则刷新页面会先闪一下登录页
 * ② 未登录只能去 login / onboard
 * ③ 没做完引导先去 onboard（记忆页例外：老用户可能只是想先看看）
 */
router.beforeEach(async (to) => {
  if (!store.state.booted) {
    try {
      await store.boot();
    } catch {
      // 启动失败也放行到登录页，那里会显示原因
    }
  }

  const loggedIn = Boolean(store.state.me) && !store.state.guest;
  const guest = store.state.guest;

  // 已登录 / 访客去登录页 → 回首页
  if (to.name === 'login' && (loggedIn || guest)) return { name: 'overview' };

  if (to.meta.public) return true;

  // 访客：能聊天，但记忆和需要真实数据的面板都进不去
  if (guest) {
    if (to.name === 'chat' || to.name === 'overview') return true;
    return { name: 'chat' };
  }

  if (!loggedIn) return { name: 'login' };

  if (store.state.needOnboarding && to.name !== 'onboard' && to.name !== 'memory') {
    return { name: 'onboard' };
  }

  return true;
});

router.afterEach((to) => {
  const t = (to.meta.title as string | undefined) ?? '麦门知己';
  document.title = t === '麦门知己' ? t : `${t} · 麦门知己`;
});
