/**
 * 新架构验证：意图解析 → 旁路（仅模糊时） → 选品 → 判断 → 算价
 *
 * 验证的核心命题（用户定的三条）：
 *   1. 意图解析由 LLM 主导，clarity 由模型判；
 *   2. 模糊意图走旁路拿判断结论，**不反问**；
 *   3. 明确意图跳过旁路，直接进第 ② 步。
 *
 * 用法：
 *   node --import tsx scripts/verify-loop.ts <token> [--dry]
 *
 * --dry 只跑到意图+旁路（不查 MCP），用来快速看解析质量，不烧额度。
 */
import { login } from '../src/services/auth.service.js';
import { runChat } from '../src/services/orchestrator.js';
import { parseIntentWithLlm, analyzeContext, applyContextToIntent } from '../src/services/llm-intent.service.js';
import { composeStrategy } from '../src/services/knowledge.service.js';
import { getMemoryService } from '../src/services/memory.service.js';
import { getDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import type { ChatReply } from '../src/types/contract.js';

const TOKEN = process.argv[2] ?? '';
const DRY = process.argv.includes('--dry');
const NOW = new Date();
const SEP = '  ' + '─'.repeat(70);

/**
 * 每条用例都标了期望路径，验证时能立刻看出"该走旁路的走了没"。
 */
const CASES: Array<{ msg: string; expect: 'vague' | 'clear'; note: string }> = [
  { msg: '今天很烦', expect: 'vague', note: '纯情绪，应走旁路' },
  { msg: '今天心情不错', expect: 'vague', note: '纯情绪，应走旁路' },
  { msg: '帮我点个午餐', expect: 'vague', note: '只表态吃饭，应走旁路（不是反问）' },
  { msg: '我饿了', expect: 'vague', note: '只表态饿，应走旁路' },
  { msg: '我要吃辣的', expect: 'clear', note: '明确口味，跳过旁路' },
  { msg: '3个人50块', expect: 'clear', note: '明确人数+预算，跳过旁路' },
  { msg: '两个人，预算80，想吃点辣的', expect: 'clear', note: '全明确，跳过旁路' },
  { msg: '我花生过敏，随便来点', expect: 'clear', note: '有硬约束，必须跳过旁路' },
];

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('用法: node --import tsx scripts/verify-loop.ts <麦当劳token> [--dry]');
    process.exit(1);
  }

  loadConfig();
  getDb();
  const { userId } = await login(TOKEN);
  console.log(`\n用户：${userId}  时间：${NOW.toLocaleString('zh-CN')}${DRY ? '  [DRY 模式]' : ''}`);

  /* ================================================================
   * 第一部分：意图解析 + 旁路（纯解析层，不查 MCP）
   * ================================================================ */
  console.log('\n' + '='.repeat(74));
  console.log('  第一部分：意图解析 + 旁路判断');
  console.log('='.repeat(74));

  const memory = getMemoryService();
  const snapshot = memory.snapshot(userId, NOW);
  const strategyCtx = composeStrategy({
    now: NOW,
    taboo: snapshot.taboo,
  });

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    console.log(`\n▸ 「${c.msg}」  — 期望 ${c.expect}（${c.note}）`);
    SEP && console.log(SEP);

    let intent = await parseIntentWithLlm(c.msg, { now: NOW });
    const okClarity = intent.clarity === c.expect;
    console.log(
      `  clarity=${intent.clarity} ${okClarity ? '✅' : '❌ 与预期不符'}  ` +
        `mood=${intent.mood ?? '无'} people=${intent.explicit.people ?? '-'} ` +
        `budget=${intent.explicit.budget ?? '-'}`,
    );
    console.log(
      `  taste=[${intent.explicit.taste.join('、')}] taboo=[${intent.explicit.taboo.join('、')}]` +
        (intent.reasoning ? `\n  依据：${intent.reasoning}` : ''),
    );
    if (okClarity) pass++;
    else fail++;

    if (intent.clarity === 'vague') {
      const ctx = await analyzeContext({
        message: c.msg,
        now: NOW,
        timeFacts: {
          slot: strategyCtx.timeSlot,
          week: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][NOW.getDay()]!,
          solarTerm: strategyCtx.solarTerm.name,
          solarTermImagery: strategyCtx.solarTerm.imagery,
          retrograde: strategyCtx.retrograde?.active ? `第 ${strategyCtx.retrograde.dayIndex} 天` : null,
        },
        snapshot: {
          taboo: snapshot.taboo,
          tasteTags: snapshot.tasteTags,
          topItems: snapshot.topItems,
          customs: snapshot.customs,
          recentMoods: snapshot.recentMoods.map((m) => ({ date: m.date, mood: m.mood })),
          ...(snapshot.budgetRange ? { budgetRange: snapshot.budgetRange } : {}),
        },
      });

      if (ctx.ran) {
        console.log(
          `  ↳ 旁路：${ctx.read || '(无读心)'} | taste=[${ctx.tasteHints.join('、')}] ` +
            `people=${ctx.people ?? '-'} budget=${ctx.budget ?? '-'}`,
        );
        if (ctx.basis.length > 0) console.log(`     依据：${ctx.basis.join('；')}`);
        const merged = applyContextToIntent(intent, ctx);
        console.log(
          `  ↳ 导入后：taste=[${merged.explicit.taste.join('、')}] ` +
            `people=${merged.explicit.people ?? '-'} budget=${merged.explicit.budget ?? '-'} ` +
            `mood=${merged.mood ?? '无'}`,
        );
        intent = merged;
      } else {
        console.log('  ↳ 旁路没跑出结论（模型失败），主 loop 会用默认值继续');
      }
    } else {
      console.log('  ↳ 意图明确，跳过旁路');
    }
  }

  console.log(`\n解析层结果：${pass} 通过 / ${fail} 不符预期`);

  if (DRY) {
    console.log('\n[DRY] 只跑了解析层，到此为止。');
    return;
  }

  /* ================================================================
   * 第二部分：完整主 loop（查真实 MCP）
   * ================================================================ */

  /**
   * 挑两条最有代表性的跑完整链路：
   *   一条模糊（验证旁路能撑起一单，且不反问）
   *   一条明确（验证跳过旁路）
   */
  const RUN_CASES = [
    { msg: '今天很烦', label: '模糊 · 应走旁路且不反问' },
    { msg: '我要吃辣的', label: '明确 · 应跳过旁路' },
  ];

  for (const rc of RUN_CASES) {
    console.log('\n' + '='.repeat(74));
    console.log(`  第二部分：完整主 loop — 「${rc.msg}」（${rc.label}）`);
    console.log('='.repeat(74));

    const stages: string[] = [];
    let reply: ChatReply | null = null;
    let errMsg = '';

    try {
      for await (const evt of runChat({ userId, message: rc.msg, fulfillment: '自取' })) {
        if (evt.type === 'stage') stages.push(evt.stage);
        else if (evt.type === 'reply') reply = evt.payload;
        else if (evt.type === 'error') errMsg = `${evt.error}: ${evt.message}`;
      }
    } catch (e) {
      errMsg = (e as Error).message;
    }

    if (errMsg) {
      console.log(`  ❌ ${errMsg}`);
      continue;
    }
    if (!reply) {
      console.log('  ❌ 没有产出 reply');
      continue;
    }

    const r = reply as ChatReply;
    console.log(`  流水线：${stages.join(' → ')}`);

    const hasContext = stages.includes('context');
    if (rc.msg === '今天很烦') {
      console.log(`  旁路${hasContext ? ' ✅ 跑了' : ' ❌ 没跑（应该跑）'}`);
    } else {
      console.log(`  旁路${hasContext ? ' ❌ 跑了（应该跳过）' : ' ✅ 正确跳过'}`);
    }

    // 反问判定：反问的回复菜单为空
    const isClarify = r.menu.length === 0;
    console.log(`  ${isClarify ? '⚠️ 出的是反问' : '✅ 直接给了菜单（没反问）'}`);

    console.log(`  门店：${r.meta.store} · ${r.meta.slot}`);
    console.log(`  标题：${r.meta.title}`);
    console.log(`  菜单 ${r.menu.length} 项：`);
    for (const m of r.menu) {
      console.log(`       ${m.name} ${m.spec} ¥${m.price.toFixed(1)}${m.why ? `  — ${m.why}` : ''}`);
    }
    console.log(`  合计 ¥${r.total.toFixed(2)}`);
    console.log(`  开场：${r.hook.slice(0, 100).replace(/\n/g, ' ')}`);

    // 落盘 + 购物车同步检查
    const cart = r.menu.length > 0;
    if (cart) console.log(`  ✅ 菜单已同步进购物车（${r.menu.length} 项）`);
  }

  console.log('\n完成。\n');
}

main().catch((e) => {
  console.error('\n验证失败：', e);
  process.exit(1);
});
