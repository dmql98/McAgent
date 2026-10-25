<script setup lang="ts">
/**
 * 三连问引导页（资料录入）
 *
 * 三步：称呼 → 生日（星座）→ 忌口。
 * 只问这三件事，因为是记忆里真正影响选品的部分：
 * 保存称呼、生日及忌口，供后续点餐参考。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { store } from '../store';
import { guessSign } from '../lib/format';
import { toast } from '../lib/toast';
import { messageOf } from '../lib/error';

const router = useRouter();

const TABOO_PRESETS = ['香菜', '洋葱', '辣', '花生', '牛肉', '奶'];

const step = ref(0);
const nickname = ref(store.state.me?.profile?.nickname ?? '');
const birthday = ref(store.state.me?.profile?.birthday ?? '');
const picked = ref<string[]>([...(store.state.me?.profile?.taboo ?? [])]);
const tabooText = ref('');
const busy = ref(false);

const signHint = ref('');

function onBirthday() {
  signHint.value = birthday.value ? `星座：${guessSign(birthday.value)}` : '';
}

function toggleTag(t: string) {
  const i = picked.value.indexOf(t);
  if (i === -1) picked.value.push(t);
  else picked.value.splice(i, 1);
}

const nextLabel = () => (step.value === 0 ? '下一步' : step.value === 1 ? '下一步' : '开始点餐');

function next() {
  if (step.value === 0) {
    if (!nickname.value.trim()) {
      toast('请填写昵称', true);
      return;
    }
    step.value = 1;
    return;
  }
  if (step.value === 1) {
    step.value = 2;
    return;
  }
  void save();
}

async function save() {
  busy.value = true;
  try {
    const typed = tabooText.value
      .split(/[、,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const taboo = [...new Set([...picked.value, ...typed])];

    const patch: { nickname: string; birthday?: string; taboo?: string[] } = {
      nickname: nickname.value.trim(),
    };
    if (birthday.value) patch.birthday = birthday.value;
    if (taboo.length) patch.taboo = taboo;

    const p = await store.saveProfile(patch);
    toast(`${p.nickname || '麦友'}，偏好已保存`);
    await router.push({ name: 'chat' });
  } catch (e) {
    toast(messageOf(e) || '保存失败，请稍后重试', true);
  } finally {
    busy.value = false;
  }
}

async function skip() {
  await router.push({ name: 'chat' });
}
</script>

<template>
  <div class="onboard-view">
    <div class="onboard-card">
      <div class="onboard-top">
        <div class="step-dots">
          <i v-for="i in 3" :key="i" :class="{ on: step === i - 1, done: step > i - 1 }" />
        </div>
        <button class="btn-link" type="button" @click="skip">以后再说</button>
      </div>

      <!-- 第 1 问 -->
      <div v-if="step === 0" class="ask">
        <div class="ask-dot">1</div>
        <p>怎么称呼你？<em>填写常用昵称。</em></p>
      </div>
      <div v-if="step === 0" class="onboard-body">
        <input
          v-model="nickname"
          class="input"
          type="text"
          maxlength="20"
          placeholder="比如：麦小门"
          autocomplete="nickname"
          @keyup.enter="next"
        />
      </div>

      <!-- 第 2 问 -->
      <div v-if="step === 1" class="ask">
        <div class="ask-dot">2</div>
        <p>生日是哪天？<em>选填，可直接进入下一步。</em></p>
      </div>
      <div v-if="step === 1" class="onboard-body">
        <input v-model="birthday" class="input" type="date" min="1900-01-01" @change="onBirthday" />
        <p class="onboard-hint">{{ signHint }}</p>
      </div>

      <!-- 第 3 问 -->
      <div v-if="step === 2" class="ask">
        <div class="ask-dot">3</div>
        <p>有什么不吃的？<em>可选择或补充忌口，供选餐时参考。</em></p>
      </div>
      <div v-if="step === 2" class="onboard-body">
        <div class="chips" style="margin-bottom: 10px">
          <button
            v-for="t in TABOO_PRESETS"
            :key="t"
            type="button"
            class="chip"
            :class="{ on: picked.includes(t) }"
            :aria-pressed="picked.includes(t)"
            @click="toggleTag(t)"
          >
            {{ t }}
          </button>
        </div>
        <input v-model="tabooText" class="input" type="text" maxlength="40" placeholder="还有别的用顿号隔开" />
      </div>

      <div class="onboard-foot">
        <button v-if="step > 0" class="btn btn-ghost" type="button" @click="step--">上一步</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="next">
          {{ busy ? '保存中…' : nextLabel() }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboard-view {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 18% 12%, rgba(255, 199, 44, 0.34), transparent 46%),
    radial-gradient(circle at 84% 82%, rgba(218, 41, 28, 0.12), transparent 48%),
    #FBF7F0;
  padding: 20px;
  overflow-y: auto;
}

.onboard-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 28px 30px 26px;
  width: 440px;
  max-width: 94vw;
  box-shadow: 0 18px 50px rgba(43, 33, 24, 0.12);
}

.onboard-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}

.step-dots {
  display: flex;
  gap: 6px;
}
.step-dots i {
  width: 24px;
  height: 4px;
  border-radius: 2px;
  background: var(--line);
  transition: background 0.25s;
}
.step-dots i.on {
  background: var(--red);
}
.step-dots i.done {
  background: var(--yellow);
}

.ask {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.ask-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--yellow);
  border: 2px solid var(--red);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 900;
  color: var(--red);
  flex-shrink: 0;
}
.ask p {
  font-size: 15px;
  font-weight: 800;
  line-height: 1.55;
  padding-top: 2px;
}
.ask p em {
  font-style: normal;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--ink-2);
  display: block;
  margin-top: 3px;
}

.onboard-body {
  margin-bottom: 22px;
}

.onboard-hint {
  font-size: 12.5px;
  color: var(--green);
  margin-top: 8px;
  line-height: 1.6;
  min-height: 18px;
}

.onboard-foot {
  display: flex;
  gap: 10px;
}
.onboard-foot .btn {
  flex: 1;
  padding: 12px 0;
  font-size: 15px;
  justify-content: center;
}
</style>
