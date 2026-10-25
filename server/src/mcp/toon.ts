/**
 * 麦当劳 MCP 响应的真实形状（实测，2026-10）
 *
 * content 只有 1 段 text，但内容是「Markdown 字段说明 + 内嵌 JSON」，例如：
 *
 *   每个门店的基本信息按单行展示：
 *   - **门店名称**: data[].storeName
 *   ...
 *   {"success":true,"code":200,...,"data":[{...}]}
 *   ## 展示结果时，每个门店的 storeCode 和 beCode 必须完整展示，
 *
 * 所以 JSON.parse 整段必然失败。必须把内嵌的那个 JSON 对象切出来。
 *
 * 策略（按可靠性排序）：
 * 1. 整段直接 JSON.parse（最理想）
 * 2. ```json ... ``` 包裹
 * 3. 扫描文本，找出每个 '{' / '[' 起点，用括号配对找到真正的结尾，返回第一个能解析成功的
 *    —— 关键在"括号配对"而不是"最后一个 }"，因为 JSON 后面还跟着 `## 说明` 尾巴
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('toon');

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

function tryJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* continue */
  }
  // 剥 ```json ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* continue */
    }
  }
  return undefined;
}

/**
 * 从「Markdown 说明 + JSON + 尾巴」的混合文本里切出 JSON 对象。
 *
 * 做法：逐个扫描 `{` 和 `[` 作为候选起点，用**括号配对**（正确跳过字符串内的
 * 括号和转义）找到对应结尾，再尝试 JSON.parse。第一个解析成功的就返回。
 *
 * 不能简单用 lastIndexOf('}')：JSON 后面常跟 `## 展示结果时…` 这种说明文字，
 * 也可能说明文字里本身就带括号。
 */
function extractEmbeddedJson(text: string): unknown | undefined {
  const OPEN = new Set(['{', '[']);
  const CLOSE = new Set(['}', ']']);

  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (!OPEN.has(ch!)) continue;

    // 括号配对扫描
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === '\\') {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (OPEN.has(c)) {
        stack.push(c);
      } else if (CLOSE.has(c)) {
        const top = stack.pop();
        // 括号类型必须匹配，否则这段起点不合法
        if ((top === '{' && c !== '}') || (top === '[' && c !== ']')) {
          stack.length = 0;
          break;
        }
        if (stack.length === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) continue;

    const slice = text.slice(start, end + 1);
    // 太短的片段（比如 `{}` 或 `[]`）直接跳过，避免误命中说明文字里的括号
    if (slice.length < 20) continue;

    try {
      const parsed = JSON.parse(slice);
      return parsed;
    } catch {
      /* 不是合法 JSON，继续找下一个起点 */
    }
  }

  return undefined;
}

/** 统一的"从任意文本里挖出结构化数据"入口 */
export function parseLoose(raw: string): unknown {
  if (typeof raw !== 'string') return raw;
  const direct = tryJson(raw);
  if (direct !== undefined) return direct;
  const embedded = extractEmbeddedJson(raw);
  if (embedded !== undefined) return embedded;
  log.debug(`文本里没找到 JSON，原样透传（前 120 字符）：${raw.slice(0, 120)}`);
  return raw;
}

/** 从 MCP 工具返回里提取真实数据 */
export function decodeToolResult(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') {
    if (typeof raw === 'string') return parseLoose(raw);
    return raw;
  }

  const r = raw as McpToolResult;

  // 结构化内容数组
  if (Array.isArray(r.content)) {
    const texts = r.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);

    if (texts.length === 1) {
      // 单段：可能整段是 JSON，也可能是「说明 + JSON + 尾巴」
      return parseLoose(texts[0]!);
    }
    if (texts.length > 1) {
      const parsedList = texts.map((t) => parseLoose(t));
      const allParsed = parsedList.every((p) => typeof p !== 'string');
      return allParsed ? parsedList : texts.join('\n');
    }
  }

  // 有些实现直接返回 structuredContent
  if ('structuredContent' in r) return r.structuredContent;

  return raw;
}

/**
 * 尝试把可能的 TOON 文本转成对象。
 * 实测麦当劳返回是「说明文字 + JSON」，所以统一走 parseLoose。
 */
export function decodeToon(text: string): unknown {
  return parseLoose(text);
}

/** 从工具返回里尽力挖出数组 */
export function pickArray(data: unknown, candidateKeys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of candidateKeys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
    // 再深一层
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = pickArray(v, candidateKeys);
        if (inner.length > 0) return inner;
      }
    }
  }
  return [];
}

/**
 * 把「以 code 为键的对象」转成数组，并把 key 注入为 productCode。
 *
 * 麦当劳 query-meals 的真实形状是：
 *   data.meals = { "1100": {name:"巨无霸", currentPrice:"26.5"}, "1106": {...} }
 * 商品 code 只存在于 key 上，value 里没有。所以必须把 key 合并进对象，
 * 否则下游拿不到 productCode，无法算价、无法下单。
 */
export function objectMapToArray(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      // 不覆盖已有的 code 类字段
      if (o.productCode === undefined && o.code === undefined) {
        out.push({ ...o, productCode: key });
      } else {
        out.push(o);
      }
    }
  }
  return out;
}

/** 从对象里尽力挖出第一个数字（价格类字段） */
export function pickNumber(data: unknown, candidateKeys: string[]): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  for (const k of candidateKeys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  }
  return undefined;
}

/** 从对象里尽力挖出字符串 */
export function pickString(data: unknown, candidateKeys: string[]): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  for (const k of candidateKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
