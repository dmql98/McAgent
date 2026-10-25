/**
 * 知识引擎单测
 * 覆盖：节气边界、跨年、星座边界、水逆、情绪、时段、策略合成
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSolarTerm,
  getStarSign,
  getMercuryRetrograde,
  getMoodStrategy,
  getTimeSlot,
  composeStrategy,
  strategyToPrompt,
  isBirthdayMonth,
  daysToBirthday,
} from '../src/services/knowledge.service.js';
import { ALL_MOODS } from '../src/data/mood-strategies.js';
import { SOLAR_TERMS } from '../src/data/solar-terms.js';
import { STAR_SIGNS } from '../src/data/star-signs.js';

const d = (iso: string) => new Date(`${iso}T12:00:00`);

describe('节气表', () => {
  test('霜降边界：前一天是寒露，当天是霜降', () => {
    assert.equal(getSolarTerm(d('2026-10-22')).name, '寒露');
    assert.equal(getSolarTerm(d('2026-10-23')).name, '霜降');
    assert.equal(getSolarTerm(d('2026-11-06')).name, '霜降');
    assert.equal(getSolarTerm(d('2026-11-07')).name, '立冬');
  });

  test('跨年：1/5 是小寒，1/1 还是冬至', () => {
    assert.equal(getSolarTerm(d('2026-01-05')).name, '小寒');
    assert.equal(getSolarTerm(d('2026-01-01')).name, '冬至');
    assert.equal(getSolarTerm(d('2026-12-25')).name, '冬至');
  });

  test('全年 365 天每天都命中且有且仅有一个节气', () => {
    const start = new Date('2026-01-01T12:00:00');
    const counts = new Map<string, number>();
    for (let i = 0; i < 365; i++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + i);
      const t = getSolarTerm(cur).name;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    assert.equal(counts.size, 24, `应有 24 个节气，实际 ${counts.size}`);
    for (const [name, n] of counts) {
      assert.ok(n >= 10 && n <= 20, `${name} 覆盖 ${n} 天，疑似区间异常`);
    }
  });

  test('24 个节气都有完整内容', () => {
    assert.equal(SOLAR_TERMS.length, 24);
    for (const t of SOLAR_TERMS) {
      assert.ok(t.name, '缺 name');
      assert.ok(t.imagery.length > 4, `${t.name} 缺 imagery`);
      assert.ok(t.strategy.length > 0, `${t.name} 缺 strategy`);
      assert.ok(t.keywords.length > 0, `${t.name} 缺 keywords`);
      assert.ok(t.blurb.length > 4, `${t.name} 缺 blurb`);
    }
  });
});

describe('星座表', () => {
  test('天蝎/天秤边界', () => {
    assert.equal(getStarSign(d('2026-10-23')).name, '天秤座');
    assert.equal(getStarSign(d('2026-10-24')).name, '天蝎座');
    assert.equal(getStarSign(d('2026-11-22')).name, '天蝎座');
    assert.equal(getStarSign(d('2026-11-23')).name, '射手座');
  });

  test('跨年：12/25 摩羯，1/19 摩羯，1/20 水瓶', () => {
    assert.equal(getStarSign(d('2026-12-25')).name, '摩羯座');
    assert.equal(getStarSign(d('2026-01-19')).name, '摩羯座');
    assert.equal(getStarSign(d('2026-01-20')).name, '水瓶座');
  });

  test('全年 365 天无空档', () => {
    const start = new Date('2026-01-01T12:00:00');
    const counts = new Map<string, number>();
    for (let i = 0; i < 365; i++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + i);
      const s = getStarSign(cur).name;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    assert.equal(counts.size, 12, `应有 12 个星座，实际 ${counts.size}`);
  });

  test('12 个星座内容完整', () => {
    assert.equal(STAR_SIGNS.length, 12);
    for (const s of STAR_SIGNS) {
      assert.ok(s.personality.length > 4, `${s.name} 缺 personality`);
      assert.ok(s.birthdayTactic.length > 4, `${s.name} 缺 birthdayTactic`);
    }
  });
});

describe('水逆', () => {
  test('区间内第一天 dayIndex=1', () => {
    const r = getMercuryRetrograde(d('2026-10-22'));
    assert.ok(r);
    assert.equal(r.active, true);
    assert.equal(r.dayIndex, 1);
  });

  test('区间第 3 天', () => {
    const r = getMercuryRetrograde(d('2026-10-24'));
    assert.ok(r);
    assert.equal(r.dayIndex, 3);
  });

  test('区间外 active=false', () => {
    assert.equal(getMercuryRetrograde(d('2026-09-15')), null);
    assert.equal(getMercuryRetrograde(d('2026-12-01')), null);
  });

  test('区间最后一天仍在区间', () => {
    const r = getMercuryRetrograde(d('2026-11-11'));
    assert.ok(r);
    assert.equal(r.active, true);
    assert.equal(r.phase, 'end');
  });
});

describe('情绪策略', () => {
  test('6 类情绪全覆盖且 avoid 非空', () => {
    for (const m of ALL_MOODS) {
      const s = getMoodStrategy(m);
      assert.equal(s.mood, m);
      assert.ok(s.tasteStrategy.length > 0, `${m} 缺 tasteStrategy`);
      assert.ok(s.avoid.length > 0, `${m} 缺 avoid`);
      assert.ok(s.sampleHook.length > 4, `${m} 缺 sampleHook`);
    }
  });

  test('低落必须是温和模式', () => {
    assert.equal(getMoodStrategy('低落').warmth, '温和');
    assert.ok(getMoodStrategy('低落').avoid.includes('玩梗'));
    assert.ok(getMoodStrategy('低落').avoid.includes('星座话术'));
  });

  test('烦躁要有甜辣冰', () => {
    const s = getMoodStrategy('烦躁');
    assert.ok(s.tasteStrategy.includes('甜'));
    assert.ok(s.tasteStrategy.includes('辣'));
    assert.ok(s.tasteStrategy.includes('冰'));
  });
});

describe('时段', () => {
  test('各时段边界', () => {
    const at = (h: number) => new Date(`2026-10-24T${String(h).padStart(2, '0')}:00:00`);
    assert.equal(getTimeSlot(at(5)), '早餐');
    assert.equal(getTimeSlot(at(9)), '早餐');
    assert.equal(getTimeSlot(at(10)), '午餐');
    assert.equal(getTimeSlot(at(12)), '午餐');
    assert.equal(getTimeSlot(at(14)), '下午茶');
    assert.equal(getTimeSlot(at(16)), '下午茶');
    assert.equal(getTimeSlot(at(17)), '夜市');
    assert.equal(getTimeSlot(at(21)), '夜市');
    assert.equal(getTimeSlot(at(22)), '深夜');
    assert.equal(getTimeSlot(at(2)), '深夜');
  });
});

describe('策略合成', () => {
  test('核心场景：霜降 + 天蝎生日月 + 烦躁 + 夜市 + 忌口香菜', () => {
    const ctx = composeStrategy({
      now: new Date('2026-10-24T21:30:00'),
      birthday: '1998-10-24',
      mood: '烦躁',
      taboo: ['香菜'],
    });

    assert.equal(ctx.solarTerm.name, '霜降');
    assert.equal(ctx.starSign?.name, '天蝎座');
    assert.equal(ctx.birthdayMonth, true);
    assert.equal(ctx.timeSlot, '夜市');
    assert.equal(ctx.mood, '烦躁');
    assert.equal(ctx.moodStrategy?.mood, '烦躁');
    assert.equal(ctx.retrograde?.active, true);
    assert.deepEqual(ctx.taboo, ['香菜']);
  });

  test('深夜场景：22:30 属于深夜，且当天仍是霜降/天蝎', () => {
    const ctx = composeStrategy({
      now: new Date('2026-10-24T22:30:00'),
      birthday: '1998-10-24',
      mood: '烦躁',
    });
    assert.equal(ctx.timeSlot, '深夜');
    assert.equal(ctx.solarTerm.name, '霜降');
    assert.equal(ctx.starSign?.name, '天蝎座');
  });

  test('没填生日时 starSign 为 null', () => {
    const ctx = composeStrategy({ now: d('2026-10-24'), mood: '开心' });
    assert.equal(ctx.starSign, null);
    assert.equal(ctx.birthdayMonth, false);
  });

  test('safetyMode 时 prompt 里禁止玩梗话术', () => {
    const ctx = composeStrategy({
      now: d('2026-10-24'),
      mood: '低落',
      safetyMode: true,
    });
    const p = strategyToPrompt(ctx);
    assert.ok(p.includes('禁止使用任何节气、星座、水逆相关的话术'));
    assert.ok(p.includes('禁止玩梗'));
  });

  test('正常模式 prompt 包含节气与情绪策略', () => {
    const ctx = composeStrategy({ now: d('2026-10-24'), mood: '烦躁', taboo: ['香菜'] });
    const p = strategyToPrompt(ctx);
    assert.ok(p.includes('霜降'));
    assert.ok(p.includes('烦躁'));
    assert.ok(p.includes('香菜'));
  });

  test('prompt 里忌口被标为硬约束', () => {
    const ctx = composeStrategy({ now: d('2026-10-24'), taboo: ['花生'], mood: '开心' });
    const p = strategyToPrompt(ctx);
    assert.ok(p.includes('硬约束'));
    assert.ok(p.includes('花生'));
  });
});

describe('生日', () => {
  test('生日月判定', () => {
    assert.equal(isBirthdayMonth('1998-10-24', d('2026-10-01')), true);
    assert.equal(isBirthdayMonth('1998-10-24', d('2026-11-01')), false);
    assert.equal(isBirthdayMonth(undefined, d('2026-10-01')), false);
  });

  test('距离生日天数', () => {
    assert.equal(daysToBirthday('1998-10-24', new Date('2026-10-24T12:00:00')), 0);
    assert.equal(daysToBirthday('1998-10-26', new Date('2026-10-24T12:00:00')), 2);
  });
});
