<script setup lang="ts">
/**
 * 登录页
 *
 * 身份就是用户的麦当劳 Token —— 我们没有本地账号体系。
 * 所以这一页的任务不是"注册/登录"，而是"把 Token 接进来"。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { store } from '../store';
import { ApiError, messageOf } from '../lib/error';
import { toast } from '../lib/toast';

const router = useRouter();

const token = ref('');
const busy = ref(false);
const errMsg = ref('');
const showSteps = ref(false);

function clearErr() {
  errMsg.value = '';
}

async function submit() {
  const t = token.value.trim();
  clearErr();

  if (t.length < 20) {
    errMsg.value = 'Token 似乎不完整，请检查是否复制全了';
    return;
  }

  busy.value = true;
  try {
    const r = await store.login(t);
    token.value = '';
    if (r.needOnboarding) {
      await router.push({ name: 'onboard' });
    } else {
      await router.push({ name: 'chat' });
      toast('已连接麦当劳账户');
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'TOKEN_INVALID') {
      errMsg.value = 'Token 已失效，请到 open.mcd.cn 重新生成';
    } else if (e instanceof ApiError && e.code === 'MCP_DOWN') {
      errMsg.value = '暂时无法连接麦当劳服务，请稍后重试';
    } else if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
      errMsg.value = '尝试次数过多，请稍后再试';
    } else {
      errMsg.value = messageOf(e);
    }
  } finally {
    busy.value = false;
  }
}

async function guest() {
  store.enterGuest();
  await router.push({ name: 'chat' });
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">M</div>
      <h1>麦门知己</h1>
      <p class="slogan">按人数、预算和口味，帮你配好一份麦当劳订单</p>

      <form novalidate @submit.prevent="submit">
        <label class="field-label" for="tokenInput">麦当劳账号 Token</label>
        <input
          id="tokenInput"
          v-model="token"
          class="input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="粘贴你的 Token"
          :disabled="busy"
          @input="clearErr"
        />
        <p v-if="errMsg" class="form-error" role="alert">{{ errMsg }}</p>
        <button class="btn btn-primary btn-block" type="submit" :disabled="busy">
          {{ busy ? '正在连接…' : '连接麦当劳' }}
        </button>
      </form>

      <p class="hint-center">
        没有 Token？
        <button class="btn-link" type="button" @click="showSteps = !showSteps">三步申请</button>
      </p>

      <div v-if="showSteps" class="steps">
        <div>① 打开 <a href="https://open.mcd.cn" target="_blank" rel="noopener noreferrer">open.mcd.cn</a> 扫码登录</div>
        <div>② 控制台激活开发者身份</div>
        <div>③ 复制 Token，回到这里粘贴</div>
      </div>

      <button class="guest-btn" type="button" @click="guest">
        体验点餐（访客模式，每天 1 次）
      </button>

      <p class="login-foot">
        登录后可查看菜单、优惠券和订单，付款需由你完成。
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-view {
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

.login-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 38px 36px 30px;
  width: 400px;
  max-width: 94vw;
  box-shadow: 0 18px 50px rgba(43, 33, 24, 0.12);
}

.login-logo {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--yellow);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
  font-weight: 900;
  color: var(--red);
  margin: 0 auto 14px;
  border: 3px solid var(--red);
}

.login-card h1 {
  font-size: 23px;
  text-align: center;
  font-weight: 900;
  letter-spacing: -0.3px;
}

.slogan {
  text-align: center;
  color: var(--ink-2);
  font-size: 13px;
  margin: 7px 0 26px;
  line-height: 1.65;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--ink-2);
  margin-bottom: 6px;
}

.form-error {
  font-size: 12.5px;
  color: var(--red);
  margin-top: 8px;
  line-height: 1.55;
}

.btn-block {
  margin-top: 14px;
  padding: 13px 0;
  font-size: 16px;
  border-radius: 12px;
}

.hint-center {
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-2);
  margin-top: 15px;
}

.steps {
  margin-top: 12px;
  background: var(--yellow-soft);
  border: 1px solid var(--yellow);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--ink);
  text-align: left;
}
.steps a {
  color: var(--red-dark);
  font-weight: 700;
}

.guest-btn {
  width: 100%;
  background: transparent;
  border: 1.5px dashed var(--line);
  border-radius: 9px;
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
  padding: 10px 0;
  margin-top: 14px;
  transition: border-color 0.18s, color 0.18s, background 0.18s;
}
.guest-btn:hover {
  color: var(--red);
  border-color: var(--yellow);
  background: #FFFDF7;
}

.login-foot {
  text-align: center;
  font-size: 11.5px;
  color: var(--ink-3);
  margin-top: 18px;
  line-height: 1.8;
}
</style>
