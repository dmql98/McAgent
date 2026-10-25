/**
 * TOON / Markdown 表格解析
 *
 * 实测（docs/mcp-live-report.md §0）麦当劳 MCP 的返回并不统一：
 *   1. 说明文字 + 内嵌 JSON      → 走 toon.ts 的 parseLoose
 *   2. TOON 紧凑表               → `[160]{productName,energyKcal,...}: 巨无霸,1234,...`
 *   3. Markdown 卡片             → `## 券名` + `- **优惠**: ¥22.9` + `<img>`
 *   4. Markdown 表格             → `| 列 | 列 |` + `| --- | --- |`
 *
 * 前三种已有处理（parseLoose / assets.service 的 md 解析），
 * 本文件补第 2、4 种 —— 否则 `list-nutrition-foods`（160 个餐品的营养表）
 * 只能整段当字符串丢给前端，等于没接。
 *
 * 解析原则：**能解析就解析，解析不出来就原样返回字符串**，绝不猜。
 */

/** TOON 表头：`[160]{a,b,c}:` —— 数字是行数，花括号里是列名 */
const TOON_HEADER = /^\s*\[(\d+)?\]\s*\{([^}]+)\}\s*:?\s*/;

export interface ToonTable {
  rows: Array<Record<string, string>>;
  columns: string[];
  /** 表头声明的行数（可能和实际解析出的行数不一致，仅作参考） */
  declaredRows?: number;
  /** 表头之后没能解析的残余文本 */
  rest?: string;
}

/**
 * 解析 TOON 表格。
 *
 * 兼容三种写法（实测样本都见过）：
 *   `[160]{a,b}: 1,2`
 *   `{a,b}: 1,2`
 *   `[160]{a,b}:\n1,2\n3,4`
 *
 * 值里可能含英文逗号（"巨无霸, 双层"），所以不能简单 split(',')。
 * 但 TOON 本身不做引号转义 —— 这是格式的固有缺陷，因此策略是：
 * **按列数从右往左对齐**。列数固定时，末尾几列（数值列）几乎不会含逗号，
 * 这样把多余的逗号归到靠左的文本列里，实测准确率最高。
 */
export function parseToonTable(text: string): ToonTable | undefined {
  if (typeof text !== 'string') return undefined;
  const m = text.match(TOON_HEADER);
  if (!m) return undefined;

  const columns = m[2]!
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (columns.length === 0) return undefined;

  const declaredRows = m[1] ? Number(m[1]) : undefined;
  const body = text.slice((m.index ?? 0) + m[0].length);

  const rows: Array<Record<string, string>> = [];
  for (const line of body.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // 遇到说明文字（以非值字符开头的段落）就停，TOON 表后面常跟备注
    const cells = splitCells(s, columns.length);
    if (!cells) continue;
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      row[c] = cells[i] ?? '';
    });
    rows.push(row);
  }

  if (rows.length === 0) return undefined;
  return { rows, columns, ...(declaredRows !== undefined ? { declaredRows } : {}) };
}

/**
 * 把一行按"列数"切成 n 段，多出来的逗号并进最靠左的文本列。
 *
 * 例：3 列 `巨无霸, 双层, 500, 119` →
 *   ["巨无霸, 双层", "500", "119"]（第 1 列吃掉多余逗号）
 */
function splitCells(line: string, n: number): string[] | undefined {
  const naive = line.split(',').map((s) => s.trim());
  if (naive.length === n) return naive;
  if (naive.length < n) {
    // 列数不够：可能是最后几列为空，补空串比丢弃更安全
    return [...naive, ...Array(n - naive.length).fill('')];
  }

  // 多了：从右往左保留 n-1 个，剩下的全部合并进第 1 列
  const tail = naive.slice(naive.length - (n - 1));
  const head = naive.slice(0, naive.length - (n - 1)).join(', ');
  return [head, ...tail];
}

/**
 * 解析 Markdown 表格（`| a | b |` + `| --- | --- |`）。
 * 返回的对象数组，键取自表头。
 */
export function parseMarkdownTable(text: string): Array<Record<string, string>> {
  if (typeof text !== 'string' || !text.includes('|')) return [];

  const lines = text.split(/\r?\n/);
  const out: Array<Record<string, string>> = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i]!;
    const sep = lines[i + 1]!;
    if (!head.trim().startsWith('|')) continue;
    if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(sep)) continue;
    if (!sep.includes('-')) continue;

    const columns = cellsOf(head);
    if (columns.length === 0) continue;

    for (let j = i + 2; j < lines.length; j++) {
      const row = lines[j]!;
      if (!row.trim().startsWith('|')) break;
      const cells = cellsOf(row);
      if (cells.length === 0) continue;
      const obj: Record<string, string> = {};
      columns.forEach((c, k) => {
        obj[c] = cells[k] ?? '';
      });
      out.push(obj);
    }
    break; // 一个文本里通常只有一张表
  }

  return out;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((s) => s.trim());
}

/**
 * 统一入口：把「可能是 TOON 表、可能是 md 表、可能是 JSON」的文本转成记录数组。
 * 拿不到就返回 []。
 */
export function anyTable(text: string): Array<Record<string, string>> {
  const toon = parseToonTable(text);
  if (toon) return toon.rows;
  return parseMarkdownTable(text);
}

/**
 * 数字宽松解析：'1,234' / '1234 kcal' / '--' / '' 都要能处理。
 * 拿不到有效数字返回 undefined —— 不返回 0，避免把"没数据"显示成"0 卡"。
 */
export function looseNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const cleaned = v.replace(/,/g, '').replace(/\s*(kcal|kj|g|mg|千卡|克|毫克)\s*/gi, '');
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}
