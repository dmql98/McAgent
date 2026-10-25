/**
 * 格式化工具
 */

/** 金额：整数补一位小数（¥5.0），非整数最多两位（¥39.5）—— 与 demo 定稿一致 */
export function money(n: number | null | undefined): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `¥${Number.isInteger(v) ? v.toFixed(1) : String(parseFloat(v.toFixed(2)))}`;
}

/** 纯数字，不带货币符号 */
export function num2(n: number | null | undefined): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? v.toFixed(1) : String(parseFloat(v.toFixed(2)));
}

/** 千分位 */
export function thousands(n: number | null | undefined): string {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

/** 毫秒 → 人能读的时间 */
export function ms(v: number | null | undefined): string {
  if (v === undefined || v === null) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

/** TTL 毫秒 → 「10 分钟」 */
export function ttlText(v: number | null | undefined): string {
  if (!v) return '不缓存';
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)} 分钟`;
  return `${Math.round(v / 3_600_000)} 小时`;
}

/** 相对时间：3 秒前 / 5 分钟前 */
export function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))} 秒前`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

/**
 * hook 渲染：契约唯一富文本约定 `**关键词**` → 高亮片段。
 *
 * 返回「片段数组」给 v-for 而不是拼 HTML —— Vue 的 v-text 会自动转义，
 * 这样连 XSS 的可能性都不存在（比手写 esc + 拼字符串更安全）。
 */
export interface HookPart {
  text: string;
  hook: boolean;
}

export function parseHook(raw: string): HookPart[] {
  const text = String(raw ?? '');
  const out: HookPart[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hook: false });
    out.push({ text: m[1] ?? '', hook: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hook: false });
  return out.length ? out : [{ text, hook: false }];
}

/** 星座粗算（服务端会重算，这里只为输入即时反馈） */
export function guessSign(iso: string): string {
  const parts = iso.split('-').map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return '';
  const md = m * 100 + d;
  const table: Array<[number, string]> = [
    [120, '水瓶座'], [219, '双鱼座'], [321, '白羊座'], [420, '金牛座'],
    [521, '双子座'], [622, '巨蟹座'], [703, '巨蟹座'], [723, '狮子座'],
    [823, '处女座'], [923, '天秤座'], [1024, '天蝎座'], [1123, '射手座'],
    [1222, '摩羯座'],
  ];
  for (const [limit, name] of table) if (md < limit) return name;
  return '摩羯座';
}

/** 复制到剪贴板（老浏览器降级到 textarea） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
