/**
 * 选品结构体检：用「接近真实菜单」的数据看 1/2/3 人分别点出什么。
 *
 * 数据取自用户真实对话里出现过的商品名与价格
 * （草莓新地 ¥13.5、麦辣鸡腿汉堡 ¥25.5、鱼牛汉堡随心选单人餐 ¥38.4 等），
 * 外加菜单里实际存在的 4 款双人餐。
 *
 * node --import tsx scripts/diag-struct.ts [人数...]
 */
import {
  selectProducts,
  buildMenuItems,
  comboSlots,
  isCombo,
  feedCapacity,
  qtyOf,
  servesOf,
  type RawProduct,
} from '../src/services/selector.service.js';
import type { ParsedIntent } from '../src/types/contract.js';

const MENU: RawProduct[] = [
  // 双人餐（真实存在，名字里没有「堡」）
  { productId: 'D1', name: '快乐吃鸡双人餐', price: 54.9, category: '套餐', available: true },
  { productId: 'D2', name: '大吉大利吃鸡双人餐', price: 73.9, category: '套餐', available: true },
  { productId: 'D3', name: '经典双人餐', price: 62.5, category: '套餐', available: true },
  { productId: 'D4', name: '元气满满双人餐', price: 58.9, category: '套餐', available: true },
  // 单人套餐 / 四件套
  { productId: 'S1', name: '麦辣鸡腿汉堡套餐', price: 41, category: '套餐', available: true },
  { productId: 'S2', name: '板烧鸡腿堡套餐', price: 39, category: '套餐', available: true },
  { productId: 'S3', name: '精选单人餐四件套', price: 45.9, category: '套餐', available: true },
  // 单品汉堡
  { productId: 'B1', name: '麦辣鸡腿汉堡', price: 25.5, category: '汉堡', available: true },
  { productId: 'B2', name: '汉堡包', price: 15, category: '汉堡', available: true },
  { productId: 'B3', name: '吉士汉堡包', price: 16.5, category: '汉堡', available: true },
  { productId: 'B4', name: '巨无霸', price: 22.5, category: '汉堡', available: true },
  // 饮品
  { productId: 'DR1', name: '无糖可口可乐', price: 11, category: '饮料', available: true },
  { productId: 'DR2', name: '鲜萃冰咖', price: 13, category: '饮料', available: true },
  { productId: 'DR3', name: '雪碧', price: 11, category: '饮料', available: true },
  { productId: 'DR4', name: '热红茶', price: 9, category: '饮料', available: true },
  // 小食
  { productId: 'SD1', name: '麦乐鸡5块', price: 15, category: '小食', available: true },
  { productId: 'SD2', name: '薯条（中）', price: 12, category: '小食', available: true },
  { productId: 'SD3', name: '苹果片', price: 7.5, category: '小食', available: true },
  { productId: 'SD4', name: '麦辣鸡翅', price: 13, category: '小食', available: true },
  // 甜品
  { productId: 'DS1', name: '草莓新地', price: 13.5, category: '甜品', available: true },
  { productId: 'DS2', name: '朱古力新地', price: 13.5, category: '甜品', available: true },
  { productId: 'DS3', name: '圆筒冰淇淋', price: 5, category: '甜品', available: true },
  // 随单购
  {
    productId: 'W1',
    name: '鱼牛汉堡随心选单人餐',
    price: 38.4,
    category: '套餐',
    available: true,
    withOrderOnly: true,
  },
];

function intent(people: number, budget?: number): ParsedIntent {
  return {
    explicit: { taboo: [], taste: [], ...(budget ? { budget } : {}) },
    mood: null,
    moodConfidence: 0,
    needsClarify: false,
    safetyMode: false,
    source: 'rule',
    raw: '',
  } as ParsedIntent;
}

const strategy = { name: '霜降', keywords: ['热', '暖', '可可', '汤'], taste: ['热'] } as never;
const peopleList = process.argv.slice(2).map(Number).filter((n) => n > 0);
const targets = peopleList.length ? peopleList : [1, 2, 3];

for (const people of targets) {
  const r = selectProducts({
    products: MENU,
    strategy,
    moodStrategy: null,
    snapshot: null,
    intent: intent(people),
    people,
  });
  const menu = buildMenuItems({ picked: r.items, details: r.details, people, snapshot: null });

  const total = menu.reduce((s, m) => s + m.price, 0);
  console.log(`\n===== ${people} 人 → ${menu.length} 个 SKU，合计 ¥${Math.round(total * 100) / 100} =====`);
  for (const m of menu) {
    const badges: string[] = [];
    if (isCombo({ name: m.name } as RawProduct)) {
      const slots = comboSlots(MENU.find((p) => p.name === m.name) ?? ({ name: m.name } as RawProduct));
      if (slots.drink) badges.push(`自带饮${slots.drink}`);
      if (slots.side) badges.push(`自带小食${slots.side}`);
    }
    console.log(`  ${m.name.padEnd(16)} ${m.spec.padEnd(5)} ¥${String(m.price).padStart(6)}  ${badges.join(' ')}`);
    console.log(`     why: ${m.why}`);
  }

  /* --- 结构告警 --- */
  const warns: string[] = [];
  const mains = r.items.filter((p) => /堡|套餐|件套|餐|饭|卷/.test(p.name ?? ''));
  if (people === 1 && mains.length > 1) warns.push(`1 人点了 ${mains.length} 项主食`);

  const comboDrink = r.items.filter((p) => isCombo(p) && comboSlots(p).drink > 0);
  const soloDrink = r.items.filter((p) => !isCombo(p) && /可乐|咖啡|茶|饮|水|奶|雪碧/.test(`${p.category ?? ''} ${p.name}`));
  if (comboDrink.length && soloDrink.length) {
    warns.push(`套餐（${comboDrink.map((p) => p.name).join('/')}）已含饮料，又点 ${soloDrink.map((p) => p.name).join('/')}`);
  }

  const comboSide = r.items.filter((p) => isCombo(p) && comboSlots(p).side > 0);
  const soloSide = r.items.filter((p) => !isCombo(p) && /鸡块|薯条|鸡翅|苹果/.test(`${p.category ?? ''} ${p.name}`));
  if (comboSide.length && soloSide.length > 0) {
    // 套餐自带 1 份小食，再多加 1 份属于正常「加个小食」；2 份以上才提醒
    const extra = soloSide.reduce((s, p) => s + qtyOf(p, people), 0);
    if (extra > 1) warns.push(`套餐已含小食，又补了 ${extra} 份`);
  }

  const soloSets = r.items.filter((p) => isCombo(p) && servesOf(p) === 1 && people >= 2);
  if (soloSets.length) warns.push(`${people} 人点了单人餐：${soloSets.map((p) => p.name).join('/')}`);

  // feedCapacity 只对「主食」有意义，甜品/小食不喂饱人，别计入
  const feed = r.items
    .filter((p) => /堡|套餐|件套|餐|饭|卷|主食/.test(p.name ?? ''))
    .reduce((s, p) => s + feedCapacity(p, people), 0);
  if (feed < people) warns.push(`主食只够 ${feed} 人吃`);
  if (feed > people * 1.5) warns.push(`主食超额：够 ${feed} 人吃，来了 ${people} 人`);

  if (warns.length) for (const w of warns) console.log(`  ⚠️  ${w}`);
  else console.log('  ✅ 结构合理');
}
