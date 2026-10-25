/**
 * LLM 客户端：OpenAI 兼容接口
 *
 * 只做一件事：把 messages 发给模型，返回文本。
 * 失败必须抛错让上层降级 —— 绝不允许阻塞用户。
 *
 * 硬边界（架构 §1 决策②）：LLM 只负责"说"（生成 hook / quote 文案），
 * 不参与选品、不参与报价。
 */
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { LlmFailedError } from '../lib/errors.js';
const log = createLogger('llm');
let totalUsage = { prompt: 0, completion: 0, calls: 0 };
export function llmUsage() {
    return { ...totalUsage };
}
async function once(messages, opts) {
    const cfg = loadConfig();
    if (!cfg.llm.apiKey) {
        throw new LlmFailedError('没有配置模型，先走模板兜底');
    }
    const timeoutMs = opts.timeoutMs ?? cfg.llm.timeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const body = {
            model: cfg.llm.model,
            messages,
            temperature: opts.temperature ?? 0.85,
            max_tokens: opts.maxTokens ?? 800,
        };
        if (opts.json)
            body.response_format = { type: 'json_object' };
        const res = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.llm.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json());
        const text = data.choices?.[0]?.message?.content ?? '';
        return { text, usage: data.usage };
    }
    finally {
        clearTimeout(timer);
    }
}
export async function chat(messages, opts = {}) {
    const started = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { text, usage } = await once(messages, opts);
            if (usage) {
                totalUsage.prompt += usage.prompt_tokens ?? 0;
                totalUsage.completion += usage.completion_tokens ?? 0;
            }
            totalUsage.calls++;
            log.debug(`llm ok model=${loadConfig().llm.model} cost=${Date.now() - started}ms ` +
                `tokens=${usage?.prompt_tokens ?? '?'}+${usage?.completion_tokens ?? '?'}`);
            return text;
        }
        catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`llm 第 ${attempt + 1} 次失败：${msg}`);
            if (attempt === 0)
                await sleep(500);
        }
    }
    log.error(`llm 全部失败，抛错让上层降级：${lastErr?.message ?? ''}`);
    throw new LlmFailedError();
}
/** JSON mode 调用 + 容错解析（剥 ```json 包裹） */
export async function chatJson(messages, opts = {}) {
    try {
        const text = await chat(messages, { ...opts, json: true });
        return parseJsonLoose(text);
    }
    catch {
        return null;
    }
}
export function parseJsonLoose(text) {
    const t = (text ?? '').trim();
    if (!t)
        return null;
    try {
        return JSON.parse(t);
    }
    catch {
        /* continue */
    }
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence?.[1]) {
        try {
            return JSON.parse(fence[1]);
        }
        catch {
            /* continue */
        }
    }
    // 尝试截取第一个 { ... } 或 [ ... ]
    const start = t.search(/[[{]/);
    if (start >= 0) {
        const openChar = t[start];
        const closeChar = openChar === '{' ? '}' : ']';
        const end = t.lastIndexOf(closeChar);
        if (end > start) {
            try {
                return JSON.parse(t.slice(start, end + 1));
            }
            catch {
                /* continue */
            }
        }
    }
    return null;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=llm.client.js.map