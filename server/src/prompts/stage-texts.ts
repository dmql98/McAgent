/**
 * SSE 阶段文案
 * 每个 stage 至少 3 条，随机选，避免每次都一样。
 */
import type { StageName } from '../types/contract.js';

export const STAGE_TEXTS: Record<StageName, string[]> = {
  intent: [
    '让我想想你想吃什么…',
    '我先琢磨一下你这句话…',
    '听出来了，让我确认一下…',
  ],
  context: [
    '想了想你今天的状态和现在几点…',
    '翻了翻你以前爱吃的，结合这会儿的时间…',
    '我大概知道你现在想吃什么样的了…',
  ],
  knowledge: [
    '翻了翻节气和你星座的运势…',
    '看看今天是什么日子…',
    '查了查今天的天气和日子…',
  ],
  menu: [
    '正在替你看菜单…',
    '翻了翻今天还热着的那几样…',
    '看看这家店现在能点什么…',
  ],
  coupon: [
    '顺便翻了翻你的优惠券…',
    '看看有没有能用的券…',
    '把能省的都算一遍…',
  ],
  review: [
    '回头看一眼这单配得对不对…',
    '再核一遍，别给你点多了…',
    '检查一下这份菜单像不像人点的…',
  ],
  compose: [
    '给你写点人话…',
    '想想要怎么跟你说…',
    '整理一下，马上好…',
  ],
};

export function pickStageText(stage: StageName): string {
  const arr = STAGE_TEXTS[stage];
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;
}

/** 极慢时的安抚文案（超过 3s 还没到下一阶段） */
export const SLOW_HINTS = [
  '麦当劳那边有点慢，再等我一下…',
  '菜单有点多，我多看两眼…',
  '快了，别急…',
];
