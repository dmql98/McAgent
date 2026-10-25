/**
 * 知识引擎：纯函数模块
 *
 * 设计原则（架构 §4）：
 * - 零 IO、零依赖、可单测
 * - 时间一律通过参数传入，不读系统时间
 * - 映射表在 ../data/ 下，本文件只做查询与合成
 */
import { SOLAR_TERMS } from '../data/solar-terms.js';
import { STAR_SIGNS } from '../data/star-signs.js';
import { MOOD_STRATEGIES } from '../data/mood-strategies.js';
import { MERCURY_RETROGRADE_2026, MERCURY_RETROGRADE_2027 } from '../data/mercury-retrograde.js';
import type {
  Mood,
  MoodStrategy,
  RetrogradeInfo,
  SolarTerm,
  StarSign,
  StrategyContext,
  TimeSlot,
} from '../types/contract.js';

/* ------------------------------------------------------------------ */
/* 日期工具                                                            */
/* ------------------------------------------------------------------ */

/** 把日期折算成"当年第几天"，方便区间比较 */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const cur = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((cur - start) / 86_400_000) + 1;
}

/** 区间是否跨年 */
function isWrapping(startMonth: number, endMonth: number): boolean {
  return endMonth < startMonth;
}

function inRange(
  m: number,
  d: number,
  range: { startMonth: number; startDay: number; endMonth: number; endDay: number },
): boolean {
  const cur = m * 100 + d;
  const start = range.startMonth * 100 + range.startDay;
  const end = range.endMonth * 100 + range.endDay;
  if (isWrapping(range.startMonth, range.endMonth)) {
    return cur >= start || cur <= end;
  }
  return cur >= start && cur <= end;
}

/* ------------------------------------------------------------------ */
/* 节气                                                                */
/* ------------------------------------------------------------------ */

export function getSolarTerm(date: Date): SolarTerm {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hit = SOLAR_TERMS.find((t) => inRange(m, d, t));
  // 理论上全年无缝，兜底返回最近的
  return hit ?? SOLAR_TERMS[0]!;
}

/** 距离下一个节气的天数，用于"再过 3 天就立冬"这类叙事 */
export function daysToNextSolarTerm(date: Date): { term: SolarTerm; days: number } {
  const cur = getSolarTerm(date);
  const idx = SOLAR_TERMS.findIndex((t) => t.name === cur.name);
  const next = SOLAR_TERMS[(idx + 1) % SOLAR_TERMS.length]!;

  const probe = new Date(date.getTime());
  for (let i = 1; i <= 20; i++) {
    probe.setDate(probe.getDate() + 1);
    if (getSolarTerm(probe).name !== cur.name) {
      return { term: next, days: i };
    }
  }
  return { term: next, days: 15 };
}

/* ------------------------------------------------------------------ */
/* 星座                                                                */
/* ------------------------------------------------------------------ */

export function getStarSign(date: Date): StarSign {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hit = STAR_SIGNS.find((s) => inRange(m, d, s));
  return hit ?? STAR_SIGNS[0]!;
}

export function getStarSignByName(name: string): StarSign | null {
  return STAR_SIGNS.find((s) => s.name === name) ?? null;
}

/** 生日月判定：按星座区间 / 或按出生月与当前月相同 */
export function isBirthdayMonth(birthday: string | undefined, today: Date): boolean {
  if (!birthday) return false;
  const bd = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(bd.getTime())) return false;
  return bd.getMonth() === today.getMonth();
}

/** 今天是否就是生日当天 */
export function isBirthdayToday(birthday: string | undefined, today: Date): boolean {
  if (!birthday) return false;
  const bd = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(bd.getTime())) return false;
  return bd.getMonth() === today.getMonth() && bd.getDate() === today.getDate();
}

/** 距离生日还有几天（今年已过则算明年） */
export function daysToBirthday(birthday: string | undefined, today: Date): number | null {
  if (!birthday) return null;
  const bd = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(bd.getTime())) return null;
  const thisYear = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (thisYear.getTime() < t0.getTime()) {
    thisYear.setFullYear(thisYear.getFullYear() + 1);
  }
  return Math.round((thisYear.getTime() - t0.getTime()) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* 水逆                                                                */
/* ------------------------------------------------------------------ */

function toUtcDay(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000);
}

export function getMercuryRetrograde(today: Date): RetrogradeInfo | null {
  const periods = [...MERCURY_RETROGRADE_2026, ...MERCURY_RETROGRADE_2027];
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const curIso = `${y}-${m}-${d}`;
  const cur = toUtcDay(curIso);

  for (const p of periods) {
    const s = toUtcDay(p.start);
    const e = toUtcDay(p.end);
    // 判断日期是否落在这个区间（只比较区间本身，不跨年处理，静态表里没有跨年项）
    const pYear = Number(p.start.slice(0, 4));
    if (pYear !== y && Number(p.end.slice(0, 4)) !== y) continue;
    if (cur >= s && cur <= e) {
      const dayIndex = cur - s + 1;
      const total = e - s + 1;
      const ratio = dayIndex / total;
      const phase: RetrogradeInfo['phase'] = ratio <= 0.25 ? 'start' : ratio >= 0.8 ? 'end' : 'mid';
      return { active: true, dayIndex, phase, startDate: p.start, endDate: p.end };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 情绪                                                                */
/* ------------------------------------------------------------------ */

export function getMoodStrategy(mood: Mood): MoodStrategy {
  return MOOD_STRATEGIES[mood];
}

/* ------------------------------------------------------------------ */
/* 时段                                                                */
/* ------------------------------------------------------------------ */

export function getTimeSlot(date: Date): TimeSlot {
  const h = date.getHours();
  if (h >= 5 && h < 10) return '早餐';
  if (h >= 10 && h < 14) return '午餐';
  if (h >= 14 && h < 17) return '下午茶';
  if (h >= 17 && h < 22) return '夜市';
  return '深夜';
}

/** 该时段可售的餐段名（与 MCP 对齐时可能需要映射） */
export function slotToMealPeriod(slot: TimeSlot): string {
  switch (slot) {
    case '早餐':
      return 'breakfast';
    case '午餐':
      return 'lunch';
    case '下午茶':
      return 'afternoon';
    case '夜市':
      return 'dinner';
    case '深夜':
      return 'latenight';
  }
}

/* ------------------------------------------------------------------ */
/* 策略合成                                                            */
/* ------------------------------------------------------------------ */

export interface ComposeInput {
  now: Date;
  birthday?: string;
  mood?: Mood | null;
  taboo?: string[];
  safetyMode?: boolean;
}

export function composeStrategy(input: ComposeInput): StrategyContext {
  const { now, birthday, mood, taboo = [], safetyMode = false } = input;

  const solarTerm = getSolarTerm(now);
  const starSign = birthday ? getStarSign(new Date(`${birthday}T00:00:00`)) : null;
  const birthdayMonth = isBirthdayMonth(birthday, now);
  const retrograde = getMercuryRetrograde(now);
  const timeSlot = getTimeSlot(now);
  const moodStrategy = mood ? getMoodStrategy(mood) : null;

  return {
    solarTerm,
    starSign,
    birthdayMonth,
    retrograde,
    mood: mood ?? null,
    moodStrategy,
    timeSlot,
    taboo,
    safetyMode,
  };
}

/**
 * 转成给 LLM 的 L3 层文本（自然语言，不是 JSON）
 * 要求：说清"为什么这么推荐"，让模型能点明出处。
 */
export function strategyToPrompt(ctx: StrategyContext): string {
  const lines: string[] = [];

  const { solarTerm, starSign, birthdayMonth, retrograde, moodStrategy, timeSlot, taboo, safetyMode } = ctx;

  lines.push(`【节气】今天是${solarTerm.name}。${solarTerm.imagery}。取向：${solarTerm.strategy.join('、')}。`);
  if (!safetyMode) lines.push(`可用的节气文案：${solarTerm.blurb}`);

  if (starSign) {
    if (!safetyMode) {
      lines.push(`【星座】${starSign.name}，${starSign.personality}。取向：${starSign.strategy.join('、')}。`);
      if (birthdayMonth) lines.push(`【生日月】本月是 ta 的生日月：${starSign.birthdayTactic}`);
    }
  }

  if (retrograde?.active && !safetyMode) {
    lines.push(
      `【水逆】水逆第 ${retrograde.dayIndex} 天（${retrograde.startDate} 起）。策略：稳住型，熟悉口味不冒险。`,
    );
  }

  lines.push(`【时段】${timeSlot}。`);

  if (moodStrategy) {
    lines.push(
      `【情绪】用户情绪是「${moodStrategy.mood}」。口味取向：${moodStrategy.tasteStrategy.join('、')}；` +
        `应避开：${moodStrategy.avoid.join('、')}；语气温度：${moodStrategy.warmth}。`,
    );
    if (!safetyMode) lines.push(`开场参考（不要照抄，要像自己说的话）：${moodStrategy.sampleHook}`);
  }

  if (taboo.length > 0) {
    lines.push(`【硬约束】用户忌口/过敏：${taboo.join('、')}。这些**绝对不能出现在菜单里**，包括配料。`);
  }

  if (safetyMode) {
    lines.push(
      '【重要】用户表现出明显的低落情绪。**禁止使用任何节气、星座、水逆相关的话术，禁止玩梗。**' +
        '用平实的语言，像一个真正关心人的朋友那样说话。可以推荐食物，但不要用食物来"治疗"情绪。',
    );
  }

  return lines.join('\n');
}

export const __internal = { dayOfYear, inRange, toUtcDay };
