/**
 * 水逆区间静态表
 *
 * ⚠️ 演示用静态表，非天文精确。真实水逆每年 3–4 次，每次约 3 周。
 * 数据来源为占星通行区间，仅用于产品叙事，不用于任何计算/预测。
 */
export interface RetrogradePeriod {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export const MERCURY_RETROGRADE_2026: RetrogradePeriod[] = [
  { start: '2026-02-26', end: '2026-03-20' },
  { start: '2026-06-29', end: '2026-07-23' },
  { start: '2026-10-22', end: '2026-11-11' },
];

export const MERCURY_RETROGRADE_2027: RetrogradePeriod[] = [
  { start: '2027-02-09', end: '2027-03-03' },
  { start: '2027-06-10', end: '2027-07-04' },
  { start: '2027-10-07', end: '2027-10-28' },
];
