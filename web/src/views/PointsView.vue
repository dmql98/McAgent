<script setup lang="ts">
/**
 * 积分与抽奖
 *
 * 对应工具：query-my-account（积分账户）、query-lottery-info（抽奖活动）、
 * query-my-prizes（我的奖品）、draw-lottery（抽奖，写操作）
 *
 * 两个坑都在这页：
 * ① 服务端把 currentMonthExpirePoint 拼成 currentMouthExpirePoint（Mouth）
 * ② draw-lottery 是写操作，它会真的消耗机会/积分，必须二次确认
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { thousands } from '../lib/format';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import type { AccountInfo } from '../types';

const f = useFetch(() => api.points());

const account = computed(() => f.data.value?.account.data as AccountInfo | undefined);
const lottery = computed(() => f.data.value?.lottery.data);
const prizes = computed(() => f.data.value?.prizes.data.items ?? []);

/** 抽奖：写操作，先确认 */
const confirmOpen = ref(false);
const drawing = ref(false);

async function doDraw() {
  drawing.value = true;
  try {
    const r = await api.callTool('draw-lottery', {}, true);
    toast(r.text?.slice(0, 60) || '抽奖完成');
    confirmOpen.value = false;
    await f.reload();
  } catch (e) {
    toast(messageOf(e) || '抽奖没成功', true);
  } finally {
    drawing.value = false;
  }
}

const eligible = computed(() => lottery.value?.decision?.eligible === true);
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>积分与抽奖</h2>
        <p class="panel-sub">
          查看可用积分、即将过期的积分、抽奖活动和已获奖品。
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新</button>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :skeleton-rows="4"
      @retry="f.reload()"
    >
      <!-- 积分账户 -->
      <section class="card acc-card">
        <div class="acc-head">
          <div class="card-title" style="margin: 0">⭐ 积分账户</div>
        </div>

        <div v-if="account" class="acc-body">
          <div class="acc-main">
            <b>{{ thousands(account.available) }}</b>
            <span>可用积分</span>
          </div>
          <div class="acc-grid">
            <div class="ag">
              <span>累计获得</span>
              <b>{{ thousands(account.accumulated) }}</b>
            </div>
            <div class="ag">
              <span>已使用</span>
              <b>{{ thousands(account.used) }}</b>
            </div>
            <div class="ag" :class="{ warn: account.expiringThisMonth > 0 }">
              <span>本月将过期</span>
              <b>{{ thousands(account.expiringThisMonth) }}</b>
            </div>
            <div class="ag">
              <span>已过期</span>
              <b>{{ thousands(account.expired) }}</b>
            </div>
            <div v-if="account.frozen" class="ag">
              <span>冻结中</span>
              <b>{{ thousands(account.frozen) }}</b>
            </div>
            <div v-if="account.level" class="ag">
              <span>会员等级</span>
              <b>{{ account.level }}</b>
            </div>
          </div>
        </div>
        <div v-else class="empty-box compact">没拿到积分账户信息。</div>
      </section>

      <!-- 抽奖活动 -->
      <section class="card lottery-card">
        <div class="acc-head">
          <div class="card-title" style="margin: 0">🎰 抽奖活动</div>
        </div>

        <template v-if="lottery">
          <h3 v-if="lottery.activityName" class="lt-name">{{ lottery.activityName }}</h3>

          <div class="lt-meta">
            <span v-if="lottery.status" class="tag" :class="eligible ? 'green' : 'gray'">{{ lottery.status }}</span>
            <span v-if="lottery.availableTimes !== undefined" class="tag">剩余 {{ lottery.availableTimes }} 次</span>
            <span v-if="lottery.drawPoint" class="tag">每次 {{ lottery.drawPoint }} 积分</span>
            <span v-if="lottery.drawTypeText" class="tag gray">{{ lottery.drawTypeText }}</span>
          </div>

          <p v-if="lottery.endTime" class="lt-time">截止 {{ lottery.endTime }}</p>

          <!-- 服务端自己的决策：能不能抽、这次扣什么 -->
          <div v-if="lottery.decision" class="lt-decision" :class="{ ok: eligible }">
            <b>{{ lottery.decision.eligibleText || (eligible ? '可以抽' : '暂时不能抽') }}</b>
            <p v-if="lottery.decision.nextConsumption">这次消耗：{{ lottery.decision.nextConsumption }}</p>
            <p v-if="lottery.decision.fallback">{{ lottery.decision.fallback }}</p>
          </div>

          <!-- 奖品池 -->
          <div v-if="lottery.prizes.length" class="prize-pool">
            <h4>奖品池</h4>
            <div class="pp-list">
              <div v-for="(p, i) in lottery.prizes" :key="i" class="pp">
                <img v-if="p.image" :src="p.image" :alt="p.name" class="pp-img" loading="lazy" />
                <div v-else class="pp-img pp-ph">🎁</div>
                <span class="pp-name">{{ p.name }}</span>
                <span v-if="p.typeText" class="tag gray">{{ p.typeText }}</span>
              </div>
            </div>
          </div>

          <div class="lt-acts">
            <button class="btn btn-primary" type="button" :disabled="!eligible || drawing" @click="confirmOpen = true">
              抽一次
            </button>
            <span v-if="!eligible" class="lt-hint">现在不符合条件，按上面的说明来。</span>
            <span v-else class="lt-hint warn">抽奖将消耗机会或积分，确认前请查看本次消耗</span>
          </div>

          <!-- 二次确认 -->
          <div v-if="confirmOpen" class="confirm-bar">
            <div class="confirm-text">
              确认抽一次？<b v-if="lottery.decision?.nextConsumption">{{ lottery.decision.nextConsumption }}</b>
              <template v-else>这会消耗一次抽奖机会</template>
            </div>
            <div class="confirm-acts">
              <button class="btn btn-primary btn-sm" type="button" :disabled="drawing" @click="doDraw">
                {{ drawing ? '抽奖中…' : '确认抽' }}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="confirmOpen = false">算了</button>
            </div>
          </div>
        </template>

        <div v-else class="empty-box compact">
          暂无进行中的抽奖活动，可稍后查看。
        </div>
      </section>

      <!-- 我的奖品 -->
      <section class="card">
        <div class="acc-head">
          <div class="card-title" style="margin: 0">🏆 我的奖品</div>
        </div>

        <div v-if="prizes.length" class="my-prizes">
          <div v-for="p in prizes" :key="p.id" class="mp">
            <img v-if="p.image" :src="p.image" :alt="p.name" class="mp-img" loading="lazy" />
            <div v-else class="mp-img mp-ph">🏆</div>
            <div class="mp-body">
              <b>{{ p.name }}</b>
              <span v-if="p.time" class="mp-time">{{ p.time }}</span>
              <span v-if="p.remind" class="mp-remind">{{ p.remind }}</span>
            </div>
            <span v-if="p.status" class="tag" :class="p.status.includes('过期') ? 'gray' : 'green'">{{ p.status }}</span>
          </div>
        </div>
        <div v-else class="empty-box compact">暂无奖品记录</div>
      </section>
    </AsyncBlock>
  </div>
</template>

<style scoped>
.acc-card,
.lottery-card,
.card + .card {
  margin-bottom: 14px;
}
.acc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.acc-body {
  display: flex;
  gap: 26px;
  align-items: center;
  flex-wrap: wrap;
}
.acc-main {
  text-align: center;
  flex-shrink: 0;
}
.acc-main b {
  display: block;
  font-size: 36px;
  font-weight: 900;
  color: var(--red-dark);
  line-height: 1.1;
  letter-spacing: -1.2px;
  font-family: 'SF Mono', Consolas, monospace;
}
.acc-main span {
  font-size: 11px;
  color: var(--ink-3);
}

.acc-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 20px;
  flex: 1;
  min-width: 240px;
}
.ag span {
  display: block;
  font-size: 10.5px;
  color: var(--ink-3);
}
.ag b {
  display: block;
  font-size: 14px;
  font-weight: 800;
  font-family: 'SF Mono', Consolas, monospace;
}
.ag.warn b {
  color: var(--red);
}
@media (max-width: 700px) {
  .acc-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.lt-name {
  font-size: 15px;
  font-weight: 800;
  margin-bottom: 8px;
}
.lt-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.lt-time {
  font-size: 11.5px;
  color: var(--ink-3);
}

.lt-decision {
  margin-top: 10px;
  border: 1px solid var(--line);
  background: #FEFCF7;
  border-radius: 9px;
  padding: 10px 13px;
}
.lt-decision.ok {
  border-color: rgba(30, 123, 79, 0.25);
  background: var(--green-soft);
}
.lt-decision b {
  font-size: 12.5px;
  color: var(--ink);
}
.lt-decision p {
  font-size: 11.5px;
  color: var(--ink-2);
  line-height: 1.6;
  margin-top: 3px;
}

.prize-pool {
  margin-top: 14px;
}
.prize-pool h4 {
  font-size: 11.5px;
  font-weight: 800;
  color: var(--ink-2);
  margin-bottom: 8px;
}
.pp-list {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}
.pp {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 78px;
  text-align: center;
}
.pp-img {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  object-fit: cover;
  background: var(--yellow-soft);
}
.pp-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  opacity: 0.6;
}
.pp-name {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ink-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.lt-acts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.lt-hint {
  font-size: 11.5px;
  color: var(--ink-3);
}
.lt-hint.warn {
  color: var(--red-dark);
}

.confirm-bar {
  margin-top: 12px;
  background: var(--yellow-soft);
  border: 1.5px solid var(--yellow);
  border-radius: 12px;
  padding: 12px 14px;
}
.confirm-text {
  font-size: 12.5px;
  line-height: 1.65;
}
.confirm-text b {
  color: var(--red-dark);
}
.confirm-acts {
  display: flex;
  gap: 9px;
  margin-top: 10px;
}

.my-prizes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp {
  display: flex;
  align-items: center;
  gap: 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 12px;
}
.mp-img {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--yellow-soft);
  flex-shrink: 0;
}
.mp-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  opacity: 0.6;
}
.mp-body {
  flex: 1;
  min-width: 0;
}
.mp-body b {
  font-size: 12.5px;
  font-weight: 700;
  display: block;
}
.mp-time {
  font-size: 10.5px;
  color: var(--ink-3);
  display: block;
  margin-top: 2px;
}
.mp-remind {
  font-size: 10.5px;
  color: var(--red-dark);
  display: block;
  margin-top: 2px;
}
</style>
