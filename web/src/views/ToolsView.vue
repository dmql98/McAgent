<script setup lang="ts">
/**
 * MCP 工具台
 *
 * 这页是「把 MCP 的东西都能展现出来」的落脚点：
 *   ① 35 个工具按六个能力域全量列出，含参数 schema、缓存 TTL、读写属性
 *   ② 每个工具都能直接调一次，看到服务端**原始返回文本**
 *   ③ 写操作必须二次确认（服务端也会再挡一次）
 *
 * 为什么原始文本重要：MCP 的返回是四种格式混用的（说明文字+内嵌 JSON /
 * TOON 紧凑表 / markdown 券面 / markdown 表格）。只看归一化后的卡片，
 * 就感受不到"这真的是从麦当劳拿的"。
 */
import { computed, ref } from 'vue';
import { api } from '../api';
import { useFetch } from '../lib/useFetch';
import { ttlText } from '../lib/format';
import { messageOf } from '../lib/error';
import { toast } from '../lib/toast';
import AsyncBlock from '../components/AsyncBlock.vue';
import SourceBadge from '../components/SourceBadge.vue';
import type { ToolCallResult, ToolMeta } from '../types';

const f = useFetch(() => api.tools());

const tools = computed(() => f.data.value?.tools ?? []);
const groups = computed(() => f.data.value?.groups ?? []);
const stats = computed(() => f.data.value?.stats);

const kw = ref('');
const group = ref<string>('');
const onlyWrite = ref(false);

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return tools.value.filter((t) => {
    if (group.value && t.group !== group.value) return false;
    if (onlyWrite.value && t.readonly) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.title.toLowerCase().includes(q) ||
      t.use.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
    );
  });
});

/** 按 group 分块展示 */
const byGroup = computed(() => {
  const map = new Map<string, ToolMeta[]>();
  for (const t of filtered.value) {
    if (!map.has(t.group)) map.set(t.group, []);
    map.get(t.group)!.push(t);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

/* ---------------- 调用面板 ---------------- */

const active = ref<ToolMeta | null>(null);
const argsText = ref('{}');
const confirmWrite = ref(false);
const calling = ref(false);
const result = ref<ToolCallResult | null>(null);
const callErr = ref<unknown>(undefined);
const showRawOnly = ref(false);

function pick(t: ToolMeta) {
  active.value = t;
  result.value = null;
  callErr.value = undefined;
  confirmWrite.value = false;
  showRawOnly.value = false;

  // 用目录里的参数 schema 生成一份可改的模板
  const tmpl: Record<string, unknown> = {};
  for (const a of t.args) {
    if (a.default !== undefined) tmpl[a.name] = a.default;
    else if (a.required) tmpl[a.name] = a.type === 'number' ? 0 : a.enum?.length ? a.enum[0] : '';
  }
  argsText.value = JSON.stringify(tmpl, null, 2);
}

const parsedArgs = computed<{ ok: boolean; value: Record<string, unknown>; err?: string }>(() => {
  try {
    const v = JSON.parse(argsText.value || '{}');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, value: {}, err: '参数必须是一个对象，比如 {"city":"深圳市"}' };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, value: {}, err: `JSON 写错了：${(e as Error).message}` };
  }
});

async function run() {
  const t = active.value;
  if (!t) return;
  if (!parsedArgs.value.ok) {
    toast(parsedArgs.value.err || '参数格式不对', true);
    return;
  }
  if (!t.readonly && !confirmWrite.value) {
    toast('这是写操作，先勾上确认', true);
    return;
  }

  calling.value = true;
  callErr.value = undefined;
  result.value = null;
  try {
    const r = await api.callTool(t.name, parsedArgs.value.value, !t.readonly);
    result.value = r;
    confirmWrite.value = false;
  } catch (e) {
    callErr.value = e;
  } finally {
    calling.value = false;
  }
}

/** 原始返回可能很长，默认折叠 */
const rawPreview = computed(() => {
  const txt = result.value?.text ?? '';
  if (showRawOnly.value || txt.length <= 1500) return txt;
  return `${txt.slice(0, 1500)}\n\n… 还有 ${txt.length - 1500} 个字符，点「展开全部」看完整`;
});

const prettyJson = computed(() => {
  const j = result.value?.json;
  if (j === null || j === undefined) return '';
  try {
    return JSON.stringify(j, null, 2);
  } catch {
    return String(j);
  }
});
</script>

<template>
  <div class="page-inner">
    <div class="panel-head">
      <div>
        <h2>工具台</h2>
        <p class="panel-sub">
          麦当劳开放平台共 <b>{{ stats?.total ?? 35 }}</b> 个工具：
          {{ stats?.readonly ?? '—' }} 个只读、{{ stats?.write ?? '—' }} 个写操作。
          可查看参数并测试调用，写操作需先确认。
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="f.loading.value" @click="f.reload()">刷新目录</button>
    </div>

    <!-- 筛选 -->
    <div class="toolbar">
      <input v-model="kw" class="input search" type="text" placeholder="搜工具名 / 用途，比如 券 / 门店 / price" />
      <select v-model="group" class="input select">
        <option value="">全部能力域</option>
        <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
      </select>
      <label class="write-toggle">
        <input v-model="onlyWrite" type="checkbox" />
        只看写操作
      </label>
      <span class="count">{{ filtered.length }} / {{ tools.length }}</span>
    </div>

    <AsyncBlock
      :loading="f.loading.value && !f.loaded.value"
      :error="f.error.value"
      :empty="!f.loading.value && !f.error.value && filtered.length === 0"
      empty-title="没有匹配的工具"
      empty-text="换个关键词，或者清掉筛选。"
      :skeleton-rows="6"
      @retry="f.reload()"
    >
      <div class="layout">
        <!-- 工具列表 -->
        <div class="list">
          <section v-for="g in byGroup" :key="g.name" class="grp">
            <h3 class="grp-name">{{ g.name }} <span class="grp-count">{{ g.items.length }}</span></h3>
            <div class="tlist">
              <button
                v-for="t in g.items"
                :key="t.name"
                class="tool"
                :class="{ on: active?.name === t.name, write: !t.readonly }"
                type="button"
                @click="pick(t)"
              >
                <div class="t-head">
                  <b>{{ t.title }}</b>
                  <span class="tag" :class="t.readonly ? 'green' : 'red'">{{ t.readonly ? '只读' : '写操作' }}</span>
                </div>
                <code class="t-name">{{ t.name }}</code>
                <p class="t-use">{{ t.use }}</p>
                <div class="t-meta">
                  <span v-if="t.readonly && t.gatewayTtl" class="t-ttl">缓存 {{ ttlText(t.gatewayTtl) }}</span>
                  <span v-if="!t.readonly" class="t-nocache">永不缓存</span>
                  <span v-if="t.args.length" class="t-args">{{ t.args.length }} 个参数</span>
                </div>
              </button>
            </div>
          </section>
        </div>

        <!-- 调用面板 -->
        <aside class="panel" :class="{ empty: !active }">
          <div v-if="!active" class="panel-empty">
            <div class="pe-icon">🛠️</div>
            <p>选择工具后，<br />可编辑参数并测试调用。</p>
            <p class="pe-note">写操作需勾选确认后提交。</p>
          </div>

          <template v-else>
            <header class="p-head">
              <div class="p-title">
                <h3>{{ active.title }}</h3>
                <span class="tag" :class="active.readonly ? 'green' : 'red'">
                  {{ active.readonly ? '只读' : '写操作' }}
                </span>
              </div>
              <code class="p-name">{{ active.name }}</code>
              <p class="p-use">{{ active.use }}</p>
              <p v-if="active.description" class="p-desc">{{ active.description }}</p>
            </header>

            <!-- 参数说明 -->
            <div v-if="active.args.length" class="p-args">
              <h4>参数（来自 tools/list 的 inputSchema）</h4>
              <div class="arg-table">
                <div v-for="a in active.args" :key="a.name" class="arg">
                  <code class="arg-name">{{ a.name }}</code>
                  <span class="arg-type">{{ a.type }}</span>
                  <span v-if="a.required" class="tag red">必填</span>
                  <span v-if="a.description" class="arg-desc">{{ a.description }}</span>
                  <span v-if="a.enum?.length" class="arg-enum">可选值：{{ a.enum.join(' / ') }}</span>
                </div>
              </div>
            </div>

            <!-- 参数编辑 -->
            <div class="p-editor">
              <h4>请求参数（JSON）</h4>
              <textarea v-model="argsText" class="args-input" spellcheck="false" rows="7" />
              <p v-if="!parsedArgs.ok" class="arg-err">{{ parsedArgs.err }}</p>
            </div>

            <!-- 写操作确认 -->
            <label v-if="!active.readonly" class="confirm-check">
              <input v-model="confirmWrite" type="checkbox" />
              <span>我确认提交此写操作，相关订单、地址或账户数据将发生变化</span>
            </label>

            <div class="p-acts">
              <button class="btn btn-primary" type="button" :disabled="calling || !parsedArgs.ok" @click="run">
                {{ calling ? '调用中…' : active.readonly ? '调用' : '确认并调用' }}
              </button>
              <span v-if="!active.readonly" class="p-warn">写操作直接提交至麦当劳，不使用缓存</span>
            </div>

            <!-- 结果 -->
            <div v-if="callErr" class="err-box" style="margin-top: 14px">
              <b>调用失败</b>
              <p>{{ messageOf(callErr) }}</p>
            </div>

            <div v-if="result" class="p-result">
              <div class="r-head">
                <SourceBadge :meta="result.meta" show-cost technical />
                <span class="r-len">{{ result.text.length }} 字符</span>
              </div>

              <!-- 识别到的表格 -->
              <div v-if="result.table && result.table.rows.length" class="r-sec">
                <h4>识别到的表格（{{ result.table.rows.length }} 行）</h4>
                <div class="r-table-wrap">
                  <table class="r-table">
                    <thead>
                      <tr>
                        <th v-for="c in result.table.columns" :key="c">{{ c }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, i) in result.table.rows.slice(0, 12)" :key="i">
                        <td v-for="c in result.table.columns" :key="c">{{ row[c] }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-if="result.table.rows.length > 12" class="r-more">
                  只显示前 12 行，共 {{ result.table.rows.length }} 行。
                </p>
              </div>

              <!-- 原始文本：这是主视图 -->
              <div class="r-sec">
                <h4>
                  服务端原始返回
                  <span class="r-hint">支持查看文本、JSON、表格等原始内容</span>
                </h4>
                <pre class="raw">{{ rawPreview }}</pre>
                <button
                  v-if="result.text.length > 1500 && !showRawOnly"
                  class="btn btn-ghost btn-xs"
                  type="button"
                  @click="showRawOnly = true"
                >
                  展开全部
                </button>
              </div>

              <!-- 解析出的 JSON -->
              <div v-if="prettyJson" class="r-sec">
                <h4>解析出的结构化数据</h4>
                <pre class="raw json">{{ prettyJson.slice(0, 4000) }}{{ prettyJson.length > 4000 ? '\n…（截断）' : '' }}</pre>
              </div>
            </div>
          </template>
        </aside>
      </div>
    </AsyncBlock>

    <p class="foot">
      只读调用按工具配置使用缓存，写操作不使用缓存。调用受频率限制，请勿重复提交。
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
  flex: 1;
  min-width: 180px;
  max-width: 300px;
}
.select {
  max-width: 150px;
  cursor: pointer;
}
.write-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  white-space: nowrap;
}
.count {
  font-size: 11.5px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
  margin-left: auto;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 980px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.grp {
  margin-bottom: 16px;
}
.grp-name {
  font-size: 11px;
  font-weight: 800;
  color: var(--ink-3);
  letter-spacing: 1px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.grp-count {
  font-family: 'SF Mono', Consolas, monospace;
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tool {
  text-align: left;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid transparent;
  border-radius: 9px;
  padding: 9px 12px;
  transition: border-color 0.16s, background 0.16s;
}
.tool:hover {
  border-color: var(--yellow);
}
.tool.on {
  border-color: var(--red);
  background: #FFFCF8;
  border-left-color: var(--red);
}
.tool.write {
  border-left-color: rgba(218, 41, 28, 0.35);
}
.t-head {
  display: flex;
  align-items: center;
  gap: 7px;
  justify-content: space-between;
}
.t-head b {
  font-size: 12.5px;
  font-weight: 800;
}
.t-name {
  display: block;
  font-size: 10.5px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
  margin-top: 2px;
}
.t-use {
  font-size: 11px;
  color: var(--ink-2);
  line-height: 1.55;
  margin-top: 4px;
}
.t-meta {
  display: flex;
  gap: 9px;
  margin-top: 5px;
  font-size: 9.5px;
  color: var(--ink-3);
  flex-wrap: wrap;
}
.t-ttl {
  color: var(--blue);
}
.t-nocache {
  color: var(--red);
  font-weight: 700;
}
.t-args {
  font-family: 'SF Mono', Consolas, monospace;
}

/* ---------------- 调用面板 ---------------- */
.panel {
  position: sticky;
  top: 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 16px 17px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}
.panel.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 260px;
}
.panel-empty {
  text-align: center;
  color: var(--ink-3);
  font-size: 12.5px;
  line-height: 1.8;
}
.pe-icon {
  font-size: 28px;
  opacity: 0.45;
  margin-bottom: 10px;
}
.pe-note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ink-3);
}

.p-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.p-title h3 {
  font-size: 15px;
  font-weight: 800;
}
.p-name {
  display: block;
  font-size: 11px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
  margin-top: 3px;
}
.p-use {
  font-size: 12px;
  color: var(--ink-2);
  margin-top: 7px;
  line-height: 1.65;
}
.p-desc {
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 5px;
  line-height: 1.65;
}

.p-args,
.p-editor {
  margin-top: 14px;
}
.p-args h4,
.p-editor h4,
.p-result h4 {
  font-size: 11px;
  font-weight: 800;
  color: var(--ink-2);
  margin-bottom: 7px;
}

.arg-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.arg {
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 11px;
  padding: 5px 8px;
  background: #FEFCF7;
  border-radius: 6px;
  border: 1px solid var(--line);
}
.arg-name {
  font-family: 'SF Mono', Consolas, monospace;
  font-weight: 700;
  color: var(--ink);
}
.arg-type {
  font-size: 9.5px;
  color: var(--blue);
  font-family: 'SF Mono', Consolas, monospace;
}
.arg-desc {
  color: var(--ink-3);
  font-size: 10.5px;
}
.arg-enum {
  width: 100%;
  color: var(--ink-3);
  font-size: 10px;
}

.args-input {
  width: 100%;
  border: 1.5px solid var(--line);
  border-radius: 9px;
  padding: 10px 12px;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink);
  background: #FEFCF9;
  outline: none;
  resize: vertical;
}
.args-input:focus {
  border-color: var(--red);
}
.arg-err {
  font-size: 11px;
  color: var(--red);
  margin-top: 5px;
}

.confirm-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 9px 12px;
  background: #FFF8F7;
  border: 1px solid #F3D6D2;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--red-dark);
  cursor: pointer;
}

.p-acts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.p-warn {
  font-size: 10.5px;
  color: var(--red-dark);
}

.p-result {
  margin-top: 16px;
  border-top: 1px dashed var(--line);
  padding-top: 13px;
}
.r-head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-bottom: 11px;
}
.r-len {
  font-size: 10px;
  color: var(--ink-3);
  font-family: 'SF Mono', Consolas, monospace;
}

.r-sec {
  margin-bottom: 14px;
}
.r-hint {
  font-weight: 400;
  font-size: 9.5px;
  color: var(--ink-3);
  display: block;
  margin-top: 2px;
  line-height: 1.5;
}

.r-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.r-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
  white-space: nowrap;
}
.r-table th {
  background: #FEFCF7;
  text-align: left;
  padding: 6px 9px;
  font-weight: 800;
  color: var(--ink-2);
  border-bottom: 1px solid var(--line);
}
.r-table td {
  padding: 5px 9px;
  border-bottom: 1px dashed var(--line);
  color: var(--ink-2);
  font-family: 'SF Mono', Consolas, monospace;
}
.r-table tr:last-child td {
  border-bottom: none;
}
.r-more {
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 5px;
}

.raw {
  background: #2B2118;
  color: #E8DFD2;
  border-radius: 9px;
  padding: 11px 13px;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.65;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 340px;
  overflow-y: auto;
}
.raw.json {
  background: #1F2937;
  color: #D1E0F0;
  max-height: 280px;
}

.foot {
  margin-top: 16px;
  font-size: 11px;
  color: var(--ink-3);
  line-height: 1.7;
}
</style>
