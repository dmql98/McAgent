/**
 * 记忆服务单测
 * 覆盖：去重、裁剪、同日同 mood 覆盖、快照长度、toCards 结构
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService, InMemoryStore, LIMITS } from '../src/services/memory.service.js';

const UID = 'aaaaaaaaaaaaaaaa';

function svc() {
  return new MemoryService(new InMemoryStore());
}

describe('记忆写入与去重', () => {
  test('同一 key 追加两次只留一条', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.appendFact(UID, 'custom', '可乐去冰');
    await s.appendFact(UID, 'custom', '可乐去冰');
    const m = s.load(UID);
    assert.equal(m.taste.customs.filter((c) => c === '可乐去冰').length, 1);
  });

  test('moodDiary 同日同 mood 覆盖不追加', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '烦躁', trigger: '第一次' });
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '烦躁', trigger: '第二次' });
    const m = s.load(UID);
    const same = m.moodDiary.filter((e) => e.date === '2026-10-24' && e.mood === '烦躁');
    assert.equal(same.length, 1);
    assert.equal(same[0]!.trigger, '第二次');
  });

  test('同日不同 mood 保留两条', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '烦躁', trigger: 'a' });
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '开心', trigger: 'b' });
    const m = s.load(UID);
    assert.equal(m.moodDiary.filter((e) => e.date === '2026-10-24').length, 2);
  });

  test('topItems 超 5 个时裁剪', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.updateTaste(UID, {
      topItems: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    const m = s.load(UID);
    assert.equal(m.taste.topItems.length, LIMITS.topItems);
    // 前 5 个保留，后面的被裁
    assert.deepEqual(m.taste.topItems, ['a', 'b', 'c', 'd', 'e']);
  });

  test('customs 超 10 个时裁剪', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    for (let i = 0; i < 15; i++) await s.appendFact(UID, 'custom', `习惯${i}`);
    const m = s.load(UID);
    assert.equal(m.taste.customs.length, LIMITS.customs);
  });

  test('habits.orders 超 50 条时丢最旧', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    for (let i = 0; i < 60; i++) {
      await s.recordOrder(UID, {
        date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        items: [`item${i}`],
        total: 10 + i,
      });
    }
    const m = s.load(UID);
    assert.equal(m.habits.orders.length, LIMITS.orders);
    // 最新的在最前
    assert.equal(m.habits.orders[0]!.items[0], 'item59');
  });

  test('长字符串截断到 200 字符', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    const long = 'x'.repeat(500);
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '烦躁', trigger: long });
    const m = s.load(UID);
    assert.equal(m.moodDiary[0]!.trigger.length, LIMITS.strField);
  });

  test('moodDiary 超 30 条时裁剪', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    for (let i = 1; i <= 40; i++) {
      await s.addMoodEntry(UID, {
        date: `2026-${String(Math.ceil(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        mood: '烦躁',
        trigger: `t${i}`,
      });
    }
    const m = s.load(UID);
    assert.ok(m.moodDiary.length <= LIMITS.moodDiary);
  });

  test('version 每次 save 自增', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    const v1 = s.load(UID).version;
    await s.appendFact(UID, 'custom', 'x');
    const v2 = s.load(UID).version;
    assert.ok(v2 > v1);
  });
});

describe('记忆快照', () => {
  test('snapshot 长度 < 2000 字符', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.applyProfile(UID, {
      nickname: '麦小门',
      birthday: '1998-10-24',
      taboo: ['香菜', '洋葱'],
    });
    for (let i = 0; i < 20; i++) {
      await s.addMoodEntry(UID, {
        date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        mood: '烦躁',
        trigger: 'y'.repeat(200),
      });
    }
    await s.updateTaste(UID, {
      topItems: ['麦麦鸡', '新地', '可乐', '薯条', '鸡翅'],
      customs: ['可乐去冰', '汉堡去酱'],
      sweetness: 3,
      spicy: 2,
    });
    const snap = s.snapshot(UID);
    const len = JSON.stringify(snap).length;
    assert.ok(len < 2000, `snapshot 长度 ${len}，应 < 2000`);
  });

  test('snapshot 内容正确', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.applyProfile(UID, { nickname: '麦小门', birthday: '1998-10-24', taboo: ['香菜'] });
    await s.updateTaste(UID, { topItems: ['麦麦鸡'], sweetness: 3 });
    const snap = s.snapshot(UID, new Date('2026-10-24T12:00:00'));
    assert.equal(snap.nickname, '麦小门');
    assert.equal(snap.starSign, '天蝎座');
    assert.equal(snap.birthdayMonth, true);
    assert.deepEqual(snap.taboo, ['香菜']);
    assert.ok(snap.topItems.includes('麦麦鸡'));
    assert.ok(snap.tasteTags.includes('爱甜'));
  });
});

describe('记忆管理卡片', () => {
  test('toCards 返回 5 张卡片，顺序固定', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    const cards = s.toCards(UID);
    assert.equal(cards.length, 5);
    assert.deepEqual(
      cards.map((c) => c.key),
      ['profile', 'taste', 'habits', 'moodDiary', 'rituals'],
    );
    for (const c of cards) {
      assert.ok(c.title, `${c.key} 缺 title`);
      assert.ok(c.icon, `${c.key} 缺 icon`);
      assert.ok(Array.isArray(c.lines));
      assert.ok(Array.isArray(c.entries));
    }
  });

  test('空记忆时卡片也有兜底文案（不空白）', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    const cards = s.toCards(UID);
    for (const c of cards) {
      assert.ok(c.lines.length > 0, `${c.key} 的 lines 为空，前端会显示空白`);
    }
  });

  test('填了资料后卡片有对应内容', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.applyProfile(UID, { nickname: '麦小门', birthday: '1998-10-24', taboo: ['香菜'] });
    const cards = s.toCards(UID, new Date('2026-10-24T12:00:00'));
    const profile = cards.find((c) => c.key === 'profile')!;
    assert.ok(profile.lines.some((l) => l.includes('麦小门')));
    assert.ok(profile.lines.some((l) => l.includes('香菜')));
    assert.ok(profile.entries.some((e) => e.key === 'profile.nickname'));
  });
});

describe('删除记忆', () => {
  test('删 nickname', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.applyProfile(UID, { nickname: '麦小门' });
    const ok = await s.deleteEntry(UID, 'profile.nickname');
    assert.equal(ok, true);
    assert.equal(s.load(UID).profile.nickname, undefined);
  });

  test('删某条忌口只删那一条', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.applyProfile(UID, { taboo: ['香菜', '洋葱'] });
    await s.deleteEntry(UID, 'profile.taboo.香菜');
    assert.deepEqual(s.load(UID).profile.taboo, ['洋葱']);
  });

  test('删不存在的 key 返回 false', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    assert.equal(await s.deleteEntry(UID, 'profile.taboo.不存在'), false);
  });

  test('删某条情绪日记', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.addMoodEntry(UID, { date: '2026-10-24', mood: '烦躁', trigger: 'x' });
    const ok = await s.deleteEntry(UID, 'moodDiary.2026-10-24|烦躁');
    assert.equal(ok, true);
    assert.equal(s.load(UID).moodDiary.length, 0);
  });
});

describe('下单更新习惯', () => {
  test('recordOrder 更新 topItems / budgetRange / usualStore', async () => {
    const s = svc();
    await s.ensureInitialized(UID);
    await s.recordOrder(UID, {
      date: '2026-10-24',
      items: ['麦麦鸡', '可乐'],
      total: 35,
      store: '留仙洞店',
    });
    const m = s.load(UID);
    assert.ok(m.taste.topItems.includes('麦麦鸡'));
    assert.ok(m.taste.topItems.includes('可乐'));
    assert.equal(m.habits.usualStore, '留仙洞店');
    assert.ok(m.habits.budgetRange);
    assert.ok(m.habits.budgetRange![0] <= 35);
    assert.ok(m.habits.budgetRange![1] >= 35);
  });
});
