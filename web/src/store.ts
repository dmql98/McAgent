/**
 * 全局状态
 *
 * 不引 Pinia：这个应用的状态就三块（身份 / 定位 / 门店上下文），
 * 用一个 reactive 单例 + 几个 action 足够，少一层概念。
 */
import { computed, reactive, readonly } from 'vue';
import { api } from './api';
import { ApiError, codeOf, messageOf } from './lib/error';
import type { MeResponse, MemoryCard, MemoryLocation, UserProfile } from './types';

interface State {
  /** 已登录用户；null = 未登录或访客 */
  me: MeResponse | null;
  /** 访客模式：不写记忆、每天 1 次 */
  guest: boolean;

  /** 引导是否完成（从 me.needOnboarding 同步） */
  needOnboarding: boolean;

  /** 记忆卡片（5 张，保留的核心能力） */
  memoryCards: MemoryCard[];
  memoryUpdatedAt: number;
  privacyNote: string;
  location: MemoryLocation | null;

  /** 最近一次对话的 chatId，下单要用 */
  lastChatId: string;
  /** 最近一次用户原文，定位补完可以一键重发 */
  lastUserText: string;

  /** 启动是否已跑完（避免闪现登录页） */
  booted: boolean;

  /** 全局 loading（只用于启动） */
  booting: boolean;
}

const state = reactive<State>({
  me: null,
  guest: false,
  needOnboarding: false,
  memoryCards: [],
  memoryUpdatedAt: 0,
  privacyNote: '',
  location: null,
  lastChatId: '',
  lastUserText: '',
  booted: false,
  booting: false,
});

/* ---------------- 派生 ---------------- */

const displayName = computed(() => {
  if (state.guest) return '访客';
  return state.me?.profile?.nickname || '麦友';
});

const avatarChar = computed(() => {
  const n = displayName.value;
  return n.slice(0, 1) || '麦';
});

const isLoggedIn = computed(() => Boolean(state.me) && !state.guest);

/** 门店搜索用的城市（定位反查出来的，不是坐标） */
const searchCity = computed(() => state.location?.searchCity ?? state.location?.city ?? '');

/* ---------------- 动作 ---------------- */

/** 启动时恢复会话 */
async function boot(): Promise<void> {
  state.booting = true;
  try {
    const me = await api.me();
    state.me = me;
    state.needOnboarding = me.needOnboarding;
    state.guest = false;
    if (!me.needOnboarding) await refreshMemory(true);
  } catch (e) {
    // 401 是正常未登录，不当错误
    if (!(e instanceof ApiError && (e.code === 'UNAUTHORIZED' || e.code === 'NEED_LOGIN'))) {
      throw e;
    }
    state.me = null;
  } finally {
    state.booting = false;
    state.booted = true;
  }
}

async function login(token: string): Promise<{ needOnboarding: boolean }> {
  const r = await api.login(token);
  const me = await api.me();
  state.me = me;
  state.guest = false;
  state.needOnboarding = r.needOnboarding || me.needOnboarding;
  if (!state.needOnboarding) await refreshMemory(true);
  return { needOnboarding: state.needOnboarding };
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 失败也清本地状态：用户意图是"退出"
  }
  resetLocal();
}

async function unbind(): Promise<void> {
  await api.unbind();
  resetLocal();
}

function resetLocal(): void {
  state.me = null;
  state.guest = false;
  state.needOnboarding = false;
  state.memoryCards = [];
  state.memoryUpdatedAt = 0;
  state.privacyNote = '';
  state.location = null;
  state.lastChatId = '';
  state.lastUserText = '';
}

function enterGuest(): void {
  state.guest = true;
  state.me = null;
  state.needOnboarding = false;
  state.memoryCards = [];
  state.location = null;
  state.lastChatId = '';
}

async function saveProfile(patch: Partial<Pick<UserProfile, 'nickname' | 'birthday' | 'taboo'>>): Promise<UserProfile> {
  const r = await api.updateProfile(patch);
  if (state.me) {
    state.me.profile = r.profile;
    state.me.needOnboarding = false;
  }
  state.needOnboarding = false;
  return r.profile;
}

/** 刷新记忆（silent=true 时失败不打扰用户） */
async function refreshMemory(silent = false): Promise<void> {
  if (state.guest) return;
  try {
    const data = await api.getMemory();
    state.memoryCards = data.cards;
    state.memoryUpdatedAt = data.updatedAt;
    state.privacyNote = data.privacyNote;
    state.location = data.location;
  } catch (e) {
    if (!silent) throw e;
  }
}

/** 只刷新定位（清定位之后用） */
async function refreshLocation(): Promise<void> {
  if (state.guest || !state.me) {
    state.location = null;
    return;
  }
  try {
    const info = await api.getLocation();
    state.location = {
      hasLocation: info.hasLocation,
      city: info.city ?? null,
      district: info.district ?? null,
      source: info.source,
      searchCity: info.city ?? null,
      searchKeyword: info.district ?? null,
    };
  } catch {
    // 拉不到就维持现状
  }
}

/** 删除一条记忆条目（乐观更新由组件负责，这里只调接口） */
async function deleteMemoryEntry(key: string): Promise<void> {
  await api.deleteMemory(key);
  await refreshMemory(true);
}

/* ---------------- 导出 ---------------- */

export const store = {
  state: readonly(state) as Readonly<State>,
  /** 需要直接改的少数场景（如 lastChatId），单独暴露 */
  raw: state,
  displayName,
  avatarChar,
  isLoggedIn,
  searchCity,
  boot,
  login,
  logout,
  unbind,
  enterGuest,
  saveProfile,
  refreshMemory,
  refreshLocation,
  deleteMemoryEntry,
  resetLocal,
};

export { state, messageOf, codeOf };
