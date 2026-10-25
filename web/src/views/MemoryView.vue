<script setup lang="ts">
/**
 * 偏好设置（已保存资料管理）
 *
 * 这是产品的差异点，也是用户最该信任的一页：
 *   · 5 张卡片：静态档案 / 口味画像 / 习惯数据 / 情绪日记 / 仪式记忆
 *   · 每条都可单独删除（乐观更新，失败回滚）
 *   · 定位卡：麦当劳只认城市，所以定位的产出物是「城市 + 商圈」
 *   · 解绑：必须输入「删除」二字，不做二次弹窗
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { store } from '../store';
import { ago } from '../lib/format';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import AppIcon from '../components/AppIcon.vue';

const router = useRouter();

const loading = ref(true);
const err = ref<unknown>(undefined);
const cards = ref([...[]] as import('../types').MemoryCard[]);
const removingKeys = ref<Set<string>>(new Set());

/* ---------------- 定位 ---------------- */

const locManualOpen = ref(false);
const locCity = ref('');
const locDistrict = ref('');
const locBusy = ref(false);
const locErr = ref('');

const loc = computed(() => store.state.location);
const hasLoc = computed(() => Boolean(loc.value?.hasLocation));

function locText(): string {
  const l = loc.value;
  if (!l?.hasLocation) return '设置位置后，可按所在城市查找门店';
  const where = [l.city, l.district].filter(Boolean).join(' · ') || '已设置位置';
  return l.source === 'manual' ? `${where}（手动设置）` : where;
}

/** 浏览器定位 → 后端反查城市 → 存记忆 */
async function useGeo() {
  locErr.value = '';
  if (!navigator.geolocation) {
    locErr.value = '当前浏览器不支持定位，请手动填写城市。';
    locManualOpen.value = true;
    return;
  }
  if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    locErr.value = '当前页面无法使用定位，请通过安全连接访问或手动填写城市。';
    locManualOpen.value = true;
    return;
  }

  locBusy.value = true;
  let pos: GeolocationPosition;
  try {
    pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false, // 反查城市用不到高精度，省电也更快
        timeout: 12000,
        maximumAge: 5 * 60 * 1000,
      });
    });
  } catch (e) {
    locBusy.value = false;
    const code = (e as GeolocationPositionError).code;
    locErr.value =
      code === 1
        ? '未获得定位权限，可手动填写城市。'
        : code === 2
          ? '暂时无法获取位置，可手动填写城市。'
          : '定位超时，请重试或手动填写城市。';
    if (code !== 1) locManualOpen.value = true;
    return;
  }

  try {
    const r = await api.submitLocation({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      source: 'gps',
    });
    if (r.needCity) {
      locErr.value = '无法识别所在城市，请手动填写。';
      locManualOpen.value = true;
      locBusy.value = false;
      return;
    }
    await store.refreshLocation();
    void store.refreshMemory(true);
    toast(`位置已保存：${[r.city, r.district].filter(Boolean).join(' · ')}`);
  } catch (e) {
    locErr.value = messageOf(e);
    locManualOpen.value = true;
  } finally {
    locBusy.value = false;
  }
}

async function saveManualCity() {
  const city = locCity.value.trim();
  if (!city) {
    locErr.value = '填个城市吧，比如「深圳市」';
    return;
  }
  locBusy.value = true;
  locErr.value = '';
  try {
    const r = await api.submitLocation({
      // 手填也必须有合法坐标（契约要求），(0,0) 会被拒，给深圳市民中心作占位
      lat: 22.5431,
      lng: 114.0579,
      city,
      ...(locDistrict.value.trim() ? { district: locDistrict.value.trim() } : {}),
      source: 'manual',
    });
    await store.refreshLocation();
    void store.refreshMemory(true);
    toast(`位置已保存：${[r.city, r.district].filter(Boolean).join(' · ')}`);
    locCity.value = '';
    locDistrict.value = '';
    locManualOpen.value = false;
  } catch (e) {
    locErr.value = messageOf(e);
  } finally {
    locBusy.value = false;
  }
}

async function clearLoc() {
  if (!window.confirm('清除位置后，下次查找门店时需重新设置。是否继续？')) return;
  try {
    await api.clearLocation();
    await store.refreshLocation();
    void store.refreshMemory(true);
    toast('定位已清除');
  } catch (e) {
    toast(messageOf(e), true);
  }
}

/* ---------------- 记忆 ---------------- */

async function load() {
  loading.value = true;
  err.value = undefined;
  try {
    await store.refreshMemory();
    cards.value = [...store.state.memoryCards];
  } catch (e) {
    err.value = e;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

async function removeEntry(key: string, label: string) {
  if (!window.confirm(`确定删除「${label}」？`)) return;

  // 乐观更新：先从界面拿掉
  const snapshot = cards.value.map((c) => ({ ...c, entries: [...c.entries], lines: [...c.lines] }));
  removingKeys.value.add(key);
  for (const c of cards.value) {
    c.entries = c.entries.filter((e) => e.key !== key);
  }

  try {
    await store.deleteMemoryEntry(key);
    toast('已删除');
    await load();
  } catch (e) {
    // 回滚
    cards.value = snapshot;
    toast(messageOf(e) || '删除失败，请稍后重试', true);
  } finally {
    removingKeys.value.delete(key);
  }
}

/* ---------------- 解绑 ---------------- */

const confirmWord = ref('');
const unbinding = ref(false);
const canUnbind = computed(() => confirmWord.value.trim() === '删除');

async function unbind() {
  if (!canUnbind.value || unbinding.value) return;
  unbinding.value = true;
  try {
    await store.unbind();
    toast('已解绑并删除账户数据');
    await router.push({ name: 'login' });
  } catch (e) {
    toast(messageOf(e) || '删除失败，请稍后重试', true);
  } finally {
    unbinding.value = false;
  }
}

const updatedText = computed(() => (store.state.memoryUpdatedAt ? ago(store.state.memoryUpdatedAt) : '刚刚'));
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>偏好设置</h2>
        <p class="panel-sub">
          这里保存了你主动填写或点餐时使用的信息，可随时修改或删除。更新于 {{ updatedText }}
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <!-- 定位卡：麦当劳查门店只认城市，所以这里存的其实是城市 -->
    <div class="loc-card" :class="{ on: hasLoc }">
      <div class="loc-head">
        <span class="loc-icon"><AppIcon :name="hasLoc && loc?.source === 'manual' ? 'city' : 'pin'" :size="15" /></span>
        <b>{{ hasLoc ? '当前位置' : '设置位置' }}</b>
      </div>
      <p class="loc-text" :class="{ err: locErr }">{{ locErr || locText() }}</p>

      <div v-if="!hasLoc && !locManualOpen" class="loc-acts">
        <button class="btn btn-primary btn-sm" type="button" :disabled="locBusy" @click="useGeo">
          {{ locBusy ? '定位中…' : '允许定位' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="locManualOpen = true">手填城市</button>
      </div>

      <div v-if="locManualOpen" class="loc-manual">
        <input v-model="locCity" class="input" type="text" placeholder="城市，比如 深圳市" autocomplete="off" />
        <input v-model="locDistrict" class="input" type="text" placeholder="商圈 / 街道（可不填）" autocomplete="off" />
        <div class="loc-acts">
          <button class="btn btn-primary btn-sm" type="button" :disabled="locBusy" @click="saveManualCity">
            {{ locBusy ? '保存中…' : '保存位置' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="((locManualOpen = false), (locErr = ''))">
            取消
          </button>
        </div>
      </div>

      <button v-if="hasLoc" class="btn-link" style="margin-top: 10px" type="button" @click="clearLoc">
        清除定位
      </button>
    </div>

    <!-- 五张卡片 -->
    <AsyncBlock
      :loading="loading"
      :error="err"
      :empty="!loading && !err && cards.length === 0"
      empty-title="暂无偏好记录"
      empty-text="点餐时可说明口味和忌口，已保存的信息会显示在这里。"
      :skeleton-rows="5"
      @retry="load"
    >
      <div class="stack">
        <div v-for="c in cards" :key="c.key" class="mem-group">
          <h4>{{ { profile: '个人资料', taste: '口味偏好', habits: '用餐记录', moodDiary: '历史备注', rituals: '常用记录' }[c.key] }}</h4>

          <!-- 展示行 -->
          <div v-if="c.lines.length && c.key !== 'taste'" class="mem-lines">
            <p v-for="(l, i) in c.lines" :key="i">{{ l }}</p>
          </div>

          <!-- 口味画像用标签呈现 -->
          <div v-if="c.key === 'taste' && c.lines.length" class="mem-tags">
            <span v-for="(t, i) in c.lines.join('·').split('·').map((x) => x.trim()).filter(Boolean)" :key="i" class="tag">
              {{ t }}
            </span>
          </div>

          <!-- 可删条目 -->
          <div v-if="c.entries.length" class="mem-rows">
            <div
              v-for="en in c.entries"
              :key="en.key"
              class="mem-row"
              :class="{ removing: removingKeys.has(en.key) }"
            >
              <span class="label">{{ en.label }}</span>
              <button
                class="btn-del"
                type="button"
                :aria-label="`删除 ${en.label}`"
                @click="removeEntry(en.key, en.label)"
              >
                删除
              </button>
            </div>
          </div>

          <p v-if="!c.lines.length && !c.entries.length" class="mem-empty">暂无记录</p>
        </div>
      </div>
    </AsyncBlock>

    <!-- 隐私说明 -->
    <p class="privacy">
      以上信息只用于点餐推荐。你可以逐条删除，也可以解绑账号并清除全部数据。
    </p>

    <!-- 危险区 -->
    <section class="danger-zone">
      <h4>解绑并删除全部数据</h4>
      <p>将删除登录凭证、个人资料、偏好及历史记录，无法恢复。</p>
      <div class="danger-row">
        <input
          v-model="confirmWord"
          class="input"
          type="text"
          placeholder="输入「删除」以确认"
          autocomplete="off"
          style="max-width: 220px"
        />
        <button class="btn btn-danger" type="button" :disabled="!canUnbind || unbinding" @click="unbind">
          {{ unbinding ? '正在删除…' : '解绑并删除' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.loc-card {
  margin: 0 0 18px;
  padding: 14px 16px;
  border: 1.5px dashed var(--line);
  border-radius: var(--radius);
  background: #fff;
}
.loc-card.on {
  border-style: solid;
  border-color: rgba(218, 41, 28, 0.25);
  background: #FFFCF8;
}
.loc-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
}
.loc-head b {
  font-weight: 800;
}
.loc-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--yellow-soft);
  color: var(--red-dark);
}
.loc-text {
  margin: 7px 0 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.loc-text.err {
  color: var(--red-dark);
}
.loc-acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.loc-manual {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.loc-manual .input {
  max-width: 320px;
}

.mem-group {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 15px 17px;
}
.mem-group h4 {
  font-size: 13.5px;
  color: var(--red-dark);
  margin-bottom: 9px;
  font-weight: 800;
}
.mem-lines p {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.75;
}
.mem-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mem-rows {
  margin-top: 6px;
}
.mem-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 12.5px;
  transition: opacity 0.2s;
}
.mem-row:last-child {
  border-bottom: none;
}
.mem-row .label {
  flex: 1;
  line-height: 1.55;
  word-break: break-word;
}
.mem-row.removing {
  opacity: 0.35;
  pointer-events: none;
}
.btn-del {
  border: 1.5px solid var(--line);
  background: #fff;
  color: var(--red);
  font-size: 11px;
  border-radius: 7px;
  padding: 3px 10px;
  flex-shrink: 0;
}
.btn-del:hover {
  background: #FFF1EF;
  border-color: var(--red);
}
.mem-empty {
  font-size: 12px;
  color: var(--ink-3);
}

.privacy {
  margin: 18px 0 0;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
}

.danger-zone {
  margin-top: 18px;
  border: 1px solid #F3D6D2;
  background: #FFF8F7;
  border-radius: var(--radius);
  padding: 15px 17px;
}
.danger-zone h4 {
  font-size: 13px;
  color: var(--red-dark);
  margin-bottom: 5px;
  font-weight: 800;
}
.danger-zone p {
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.7;
  margin-bottom: 11px;
}
.danger-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
