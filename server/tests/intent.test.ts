/**
 * 意图解析单测
 * 覆盖：人数/预算/忌口/口味/时段抽取、情绪分类、优先级、反问、安全模式
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/services/intent.service.js';

const NOW = new Date('2026-10-24T21:30:00');

describe('显式约束抽取', () => {
  test('4 人 150 块 有人不吃辣', () => {
    const r = parseIntent('明天中午4个人，预算150，有人不吃辣', NOW);
    assert.equal(r.explicit.people, 4);
    assert.equal(r.explicit.budget, 150);
    assert.ok(r.explicit.taboo.includes('辣'), '应识别出不吃辣为硬约束');
    assert.equal(r.explicit.targetDate, '2026-10-25');
    assert.equal(r.explicit.timeHint, '明天');
  });

  test('中文数字人数', () => {
    assert.equal(parseIntent('两个人吃', NOW).explicit.people, 2);
    assert.equal(parseIntent('我们仨', NOW).explicit.people, 3);
    assert.equal(parseIntent('就我一个人', NOW).explicit.people, 1);
  });

  test('预算多种表达', () => {
    assert.equal(parseIntent('预算100', NOW).explicit.budget, 100);
    assert.equal(parseIntent('50块左右', NOW).explicit.budget, 50);
    assert.equal(parseIntent('80以内', NOW).explicit.budget, 80);
    assert.equal(parseIntent('不超过60', NOW).explicit.budget, 60);
  });

  test('忌口抽取', () => {
    const r1 = parseIntent('我不吃香菜', NOW);
    assert.ok(r1.explicit.taboo.includes('香菜'));

    const r2 = parseIntent('我花生过敏', NOW);
    assert.ok(r2.explicit.taboo.includes('花生'));

    const r3 = parseIntent('不要洋葱', NOW);
    assert.ok(r3.explicit.taboo.includes('洋葱'));
  });

  test('「不吃辣」是硬约束，「不太辣」是软偏好', () => {
    const hard = parseIntent('我不吃辣', NOW);
    assert.ok(hard.explicit.taboo.includes('辣'));

    const soft = parseIntent('不要太辣', NOW);
    assert.ok(!soft.explicit.taboo.includes('辣'), '不太辣 不该进 taboo');
  });

  test('取餐方式', () => {
    assert.equal(parseIntent('我要外送', NOW).explicit.fulfillment, '外送');
    assert.equal(parseIntent('我到店自取', NOW).explicit.fulfillment, '自取');
    assert.equal(parseIntent('我堂食', NOW).explicit.fulfillment, '堂食');
  });

  test('口味偏好', () => {
    const r = parseIntent('想吃点甜的', NOW);
    assert.ok(r.explicit.taste.includes('甜'));
  });
});

describe('情绪分类', () => {
  test('核心场景：我好烦啊 → 烦躁', () => {
    const r = parseIntent('我好烦啊', NOW);
    assert.equal(r.mood, '烦躁');
    assert.ok(r.moodConfidence >= 0.6);
    assert.equal(r.needsClarify, false, '情绪明确时不该反问');
  });

  test('6 类情绪各命中', () => {
    assert.equal(parseIntent('烦死了', NOW).mood, '烦躁');
    assert.equal(parseIntent('累死了', NOW).mood, '疲惫');
    assert.equal(parseIntent('有点难过', NOW).mood, '低落');
    assert.equal(parseIntent('今天真开心', NOW).mood, '开心');
    assert.equal(parseIntent('升职了要庆祝', NOW).mood, '庆祝');
  });

  test('负面情绪优先于正面', () => {
    // "累死了但终于搞定了" —— 真实状态是累
    const r = parseIntent('累死了但终于搞定了', NOW);
    assert.equal(r.mood, '疲惫', '负面优先级应高于庆祝/开心');
  });

  test('讽刺检测：「太好了呢」判烦躁', () => {
    const r = parseIntent('太好了呢，又改需求', NOW);
    assert.equal(r.mood, '烦躁');
    assert.equal(r.moodConfidence, 0.5);
  });

  test('无情绪词时 mood 为 null 或平淡', () => {
    const r = parseIntent('4个人150块', NOW);
    assert.ok(r.mood === null || r.mood === '平淡');
  });
});

describe('反问判定', () => {
  test('「随便」触发反问', () => {
    const r = parseIntent('随便', NOW);
    assert.equal(r.needsClarify, true);
    assert.ok(r.clarifyQuestion);
    // 反问不能是表单
    assert.ok(!/请输入|请填写/.test(r.clarifyQuestion!));
    // 应该是二选一
    assert.ok(/还是/.test(r.clarifyQuestion!), '反问应该是有信息量的二选一');
  });

  test('「不知道吃什么」触发反问', () => {
    const r = parseIntent('不知道吃什么', NOW);
    assert.equal(r.needsClarify, true);
  });

  test('有明确约束时不反问', () => {
    const r = parseIntent('3个人吃', NOW);
    assert.equal(r.needsClarify, false);
  });

  test('纯情绪表达不反问（核心场景）', () => {
    const r = parseIntent('我好烦啊', NOW);
    assert.equal(r.needsClarify, false, '情绪明确时应直接给菜单');
  });

  /**
   * 下面这组是修「反复问同一句话」的回归测试。
   *
   * 用户被反问"想吃带劲的还是舒服的"，照着回答"来点带劲的"，
   * 系统如果认不出「带劲」就会再问一遍一模一样的话 —— 死循环。
   * 凡是反问文案里教用户说的词，解析层必须认。
   */
  test('照着反问回答「带劲」必须被认出来，不能再问一遍', () => {
    const r = parseIntent('来点带劲的', NOW);
    assert.equal(r.needsClarify, false, '「带劲」是反问文案里的原词，必须认');
    assert.ok(r.explicit.taste.includes('辣'));
  });

  test('只回「带劲的」也不能再问', () => {
    assert.equal(parseIntent('带劲的', NOW).needsClarify, false);
  });

  test('反问的另一半「舒服的」也要认', () => {
    const r = parseIntent('想吃点舒服的', NOW);
    assert.equal(r.needsClarify, false);
    assert.ok(r.explicit.taste.includes('清淡'));
  });

  test('明确说了要点餐就不能反问', () => {
    for (const s of ['帮我点个午餐', '来个午餐', '我饿了', '午饭吃啥', '来点吃的']) {
      assert.equal(parseIntent(s, NOW).needsClarify, false, `「${s}」已经表态要吃饭，不该反问`);
    }
  });

  test('问「吃什么」算点餐，「不知道吃什么」仍要反问', () => {
    assert.equal(parseIntent('吃什么', NOW).needsClarify, false);
    assert.equal(parseIntent('不知道吃什么', NOW).needsClarify, true);
  });
});

describe('安全模式', () => {
  test('极端低落触发 safetyMode', () => {
    const r = parseIntent('烦死了，活着没意思', NOW);
    assert.equal(r.safetyMode, true);
    assert.equal(r.needsClarify, false, '安全模式不反问');
  });

  test('普通低落不触发安全模式', () => {
    const r = parseIntent('今天有点难过', NOW);
    assert.equal(r.safetyMode, false);
  });
});

describe('组合输入', () => {
  test('显式指令 + 附带情绪全部生效', () => {
    const r = parseIntent('加完班好累，帮我点2人份', NOW);
    assert.equal(r.mood, '疲惫');
    assert.equal(r.explicit.people, 2);
  });
});
