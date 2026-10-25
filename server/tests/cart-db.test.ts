/**
 * 购物车集成测试（真实 SQLite 内存库）
 *
 * 单元测试验的是算法，这里验的是**存下来之后还对不对**：
 *   · 刷新页面（重新读库）购物车还在
 *   · 到店 / 外送 两份车互不污染
 *   · 改数量到 0 真的会删掉
 *   · 同一商品同特制合并、不同特制分行
 *
 * 用内存库（createMemoryDb），不碰真实 data/mcd.db。
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * cart.service 内部用的是 getDb() 单例。
 * 为了让它指向内存库，先把 dataDir 指到一个临时目录，
 * 再调用 getDb() —— 这样跑完不留垃圾文件。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mcd-cart-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = join(tmp, 'test.db');

const {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  replaceFromMenu,
  emptyCart,
} = await import('../src/services/cart.service.js');
const { getDb, closeDb } = await import('../src/db/index.js');

const UID = 'test-user-1';
const P = (id: string, name: string, price: number, extra: Record<string, unknown> = {}) => ({
  productId: id,
  name,
  price,
  ...extra,
});

before(() => {
  getDb();
});

beforeEach(async () => {
  await clearCart(UID, '自取');
  await clearCart(UID, '外送');
});

describe('增删改', () => {
  test('加一件，读回来还在（持久化）', async () => {
    await addItem(UID, P('M1', '麦辣鸡腿汉堡', 25.5), { fulfillment: '自取' });
    const cart = await getCart(UID, '自取');
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0]!.name, '麦辣鸡腿汉堡');
    assert.equal(cart.items[0]!.price, 25.5, '价格存的是单价');
    assert.equal(cart.total, 25.5);
  });

  test('同商品同特制合并数量', async () => {
    await addItem(UID, P('M1', '可乐', 11), { fulfillment: '自取' });
    await addItem(UID, P('M1', '可乐', 11), { fulfillment: '自取' });
    const cart = await getCart(UID, '自取');
    assert.equal(cart.items.length, 1, '应该合成一行');
    assert.equal(cart.items[0]!.qty, 2);
    assert.equal(cart.total, 22);
  });

  test('同商品不同特制分行', async () => {
    await addItem(UID, P('M1', '可乐', 11), { fulfillment: '自取', selected: ['去冰'] });
    await addItem(UID, P('M1', '可乐', 11), { fulfillment: '自取', selected: ['少冰'] });
    const cart = await getCart(UID, '自取');
    assert.equal(cart.items.length, 2, '不同特制应该是两行');
  });

  test('改数量', async () => {
    const c1 = await addItem(UID, P('M1', '薯条', 12), { fulfillment: '自取' });
    const id = c1.items[0]!.id;
    const c2 = await updateItem(UID, id, { qty: 3 }, { fulfillment: '自取' });
    assert.equal(c2.items[0]!.qty, 3);
    assert.equal(c2.total, 36);
  });

  test('数量改成 0 = 删除', async () => {
    const c1 = await addItem(UID, P('M1', '薯条', 12), { fulfillment: '自取' });
    const id = c1.items[0]!.id;
    const c2 = await updateItem(UID, id, { qty: 0 }, { fulfillment: '自取' });
    assert.equal(c2.items.length, 0);
    assert.equal(c2.total, 0);
  });

  test('删除指定项', async () => {
    const c1 = await addItem(UID, P('M1', '薯条', 12), { fulfillment: '自取' });
    await addItem(UID, P('M2', '可乐', 11), { fulfillment: '自取' });
    const id = c1.items[0]!.id;
    const c2 = await removeItem(UID, id, { fulfillment: '自取' });
    assert.equal(c2.items.length, 1);
    assert.equal(c2.items[0]!.name, '可乐');
  });

  test('删不存在的项报错而不是静默', async () => {
    await assert.rejects(() => removeItem(UID, 'no-such-id', { fulfillment: '自取' }));
  });

  test('清空', async () => {
    await addItem(UID, P('M1', '薯条', 12), { fulfillment: '自取' });
    const c = await clearCart(UID, '自取');
    assert.equal(c.items.length, 0);
  });
});

describe('履约方式隔离', () => {
  /**
   * 到店和外送是两套商品编码。
   * 混在一份车里，切方式下单必然失败 —— 这是本项目此前踩过的坑。
   */
  test('到店的车不会出现在外送里', async () => {
    await addItem(UID, P('PICKUP-1', '到店汉堡', 20), { fulfillment: '自取' });
    const deliveryCart = await getCart(UID, '外送');
    assert.equal(deliveryCart.items.length, 0, '外送车应该是空的');
  });

  test('两份车各自独立', async () => {
    await addItem(UID, P('A', '到店套餐', 40), { fulfillment: '自取' });
    await addItem(UID, P('B', '外送套餐', 45), { fulfillment: '外送' });
    const pick = await getCart(UID, '自取');
    const deliv = await getCart(UID, '外送');
    assert.equal(pick.items[0]!.name, '到店套餐');
    assert.equal(deliv.items[0]!.name, '外送套餐');
  });
});

describe('无编码商品拒收', () => {
  test('没有 productId 不给加（下单必失败）', async () => {
    await assert.rejects(
      () => addItem(UID, { name: '幽灵商品', price: 10 }, { fulfillment: '自取' }),
      /查不到商品编码/,
    );
  });

  test('价格异常不给加', async () => {
    await assert.rejects(
      () => addItem(UID, P('M9', '零元商品', 0), { fulfillment: '自取' }),
      /价格异常/,
    );
  });
});

describe('对话菜单入车', () => {
  /**
   * MenuItem.price 是小计、spec 带 "×N"。
   * 入车必须拆成「单价 × 数量」，否则合计翻倍或减半。
   */
  test('小计要被拆回单价和数量', async () => {
    const cart = await replaceFromMenu(
      UID,
      [
        { name: '麦辣鸡腿汉堡', spec: '×2', why: '你想吃的', price: 51, productId: 'M1' },
        { name: '草莓新地', spec: '×1', why: '收尾来一口', price: 13.5, productId: 'D1' },
      ],
      { fulfillment: '自取', store: '测试店', storeCode: 'S1' },
    );
    assert.equal(cart.items.length, 2);

    const burger = cart.items.find((x) => x.name === '麦辣鸡腿汉堡')!;
    assert.equal(burger.price, 25.5, '单价应该是 51 / 2');
    assert.equal(burger.qty, 2);

    assert.equal(cart.total, 64.5, '合计 = 51 + 13.5');
  });

  test('替换而不是合并（重新组单的语义）', async () => {
    await addItem(UID, P('OLD', '上一轮的东西', 30), { fulfillment: '自取' });
    await replaceFromMenu(UID, [{ name: '新套餐', spec: '×1', why: '', price: 50, productId: 'NEW' }], {
      fulfillment: '自取',
    });
    const cart = await getCart(UID, '自取');
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0]!.name, '新套餐');
  });

  test('没有 productId 的菜单项会被跳过（不阻断整单）', async () => {
    const cart = await replaceFromMenu(
      UID,
      [
        { name: '有编码', spec: '×1', why: '', price: 20, productId: 'OK' },
        { name: '没编码', spec: '×1', why: '', price: 30 },
      ],
      { fulfillment: '自取' },
    );
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0]!.name, '有编码');
  });

  test('门店信息被记住（下单要用）', async () => {
    await replaceFromMenu(UID, [{ name: 'x', spec: '×1', why: '', price: 10, productId: 'X' }], {
      fulfillment: '自取',
      store: '厦门麦当劳某店',
      storeCode: 'S123',
    });
    const cart = await getCart(UID, '自取');
    assert.equal(cart.store, '厦门麦当劳某店');
    assert.equal(cart.storeCode, 'S123');
  });
});

/**
 * 不传 fulfillment 时按行 id 自己找车。
 *
 * 回归的是一个会**静默改错车**的 bug：到店和外送是两份购物车，
 * 接口若把省略的 fulfillment 默认成「自取」，用户删外送里的东西
 * 就会去自取车找 —— 要么 404，要么改到同名那一行上。
 */
describe('按行 id 反查购物车（不传履约方式）', () => {
  test('不传 fulfillment 也能删掉外送那行', async () => {
    const delivery = await addItem(UID, P('D1', '外送薯条', 12), { fulfillment: '外送' });
    const rowId = delivery.items[0]!.id;

    // 自取车里放一件，制造"另一份车存在"的环境
    await addItem(UID, P('T1', '到店薯条', 12), { fulfillment: '自取' });

    await removeItem(UID, rowId); // 故意不传 fulfillment

    const after = await getCart(UID, '外送');
    assert.equal(after.items.length, 0, '外送那行应该被删掉');
    const takeout = await getCart(UID, '自取');
    assert.equal(takeout.items.length, 1, '自取车不能被动到');
    assert.equal(takeout.items[0]!.name, '到店薯条');
  });

  test('不传 fulfillment 也能改外送那行的数量', async () => {
    const delivery = await addItem(UID, P('D2', '外送汉堡', 25), { fulfillment: '外送' });
    const rowId = delivery.items[0]!.id;
    const takeout = await addItem(UID, P('T2', '到店汉堡', 25), { fulfillment: '自取' });

    await updateItem(UID, rowId, { qty: 3 });

    assert.equal((await getCart(UID, '外送')).items[0]!.qty, 3);
    assert.equal((await getCart(UID, '自取')).items[0]!.qty, takeout.items[0]!.qty, '自取那行数量不该变');
  });

  test('两份车里都没有这个 id → NotFound', async () => {
    await addItem(UID, P('D3', '外送东西', 10), { fulfillment: '外送' });
    await addItem(UID, P('T3', '到店东西', 10), { fulfillment: '自取' });
    await assert.rejects(() => updateItem(UID, 'no-such-row', { qty: 2 }), /没有这件商品/);
  });

  test('一份车都没有 → NotFound（而不是静默写入一份新的）', async () => {
    await assert.rejects(() => updateItem(UID, 'no-such-row', { qty: 2 }), /没有这件商品/);
  });
});

describe('清空', () => {
  test('不传 fulfillment → 两份车都清掉', async () => {
    await addItem(UID, P('X1', '外送的东西', 10), { fulfillment: '外送' });
    await addItem(UID, P('X2', '到店的东西', 10), { fulfillment: '自取' });

    await clearCart(UID); // 不传

    assert.equal((await getCart(UID, '外送')).items.length, 0);
    assert.equal((await getCart(UID, '自取')).items.length, 0);
  });

  test('传了 fulfillment → 只清那一份', async () => {
    await addItem(UID, P('X3', '外送的东西', 10), { fulfillment: '外送' });
    await addItem(UID, P('X4', '到店的东西', 10), { fulfillment: '自取' });

    await clearCart(UID, '外送');

    assert.equal((await getCart(UID, '外送')).items.length, 0);
    assert.equal((await getCart(UID, '自取')).items.length, 1, '自取不该被连带清掉');
  });
});

/**
 * 加购时要记住门店编码。
 *
 * 回归的是「外送合计少了运费」：外送算配送费必须同时有 storeCode / beCode /
 * addressId，缺一个 `applyDeliveryFee` 就直接 return，前端只显示商品价。
 * 加购时若把门店信息丢了，用户看到的钱就是错的 —— 比报错更危险。
 */
describe('加购记录门店信息', () => {
  test('addItem 带 storeCode / beCode 会写进车', async () => {
    await addItem(UID, P('S1', '外送商品', 20), {
      fulfillment: '外送',
      storeCode: 'S999',
      beCode: 'B999',
      addressId: 'A999',
    });
    const cart = await getCart(UID, '外送', { price: false });
    assert.equal(cart.storeCode, 'S999');
    assert.equal(cart.beCode, 'B999');
    assert.equal(cart.addressId, 'A999');
  });

  test('后续加购不会把已有门店信息冲掉', async () => {
    await addItem(UID, P('S2', '第一件', 20), {
      fulfillment: '外送',
      storeCode: 'S888',
      beCode: 'B888',
      addressId: 'A888',
    });
    // 第二次加购没带门店信息
    await addItem(UID, P('S3', '第二件', 10), { fulfillment: '外送' });

    const cart = await getCart(UID, '外送', { price: false });
    assert.equal(cart.storeCode, 'S888', '老的门店编码不能被清空');
    assert.equal(cart.beCode, 'B888');
    assert.equal(cart.items.length, 2);
  });

  /**
   * 门店**名**也要记住。
   *
   * 订单上要显示「你在哪家店取餐」。购物车只存 storeCode 的话，
   * 下单时要么重新按 city+keyword 搜（可能搜到同城另一家同名店），
   * 要么就只能显示空字符串 —— 用户拿到支付链接却不知道去哪个店。
   */
  test('addItem 带 storeName 会写进车', async () => {
    await addItem(UID, P('S4', '商品', 20), {
      fulfillment: '自取',
      storeCode: 'S777',
      storeName: '麦当劳厦门某餐厅',
    });
    const cart = await getCart(UID, '自取', { price: false });
    assert.equal(cart.store, '麦当劳厦门某餐厅');
  });

  test('已有 store 时不被 storeName 覆盖', async () => {
    await addItem(UID, P('S5', '商品', 20), { fulfillment: '自取', store: '原门店' });
    await addItem(UID, P('S6', '商品2', 10), { fulfillment: '自取', storeName: '新解析的门店' });
    const cart = await getCart(UID, '自取', { price: false });
    assert.equal(cart.store, '原门店', '已经有名字了就不该被后到的解析结果盖掉');
  });
});

test.after(() => {
  closeDb();
});
