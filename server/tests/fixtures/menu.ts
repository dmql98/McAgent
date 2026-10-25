/**
 * 测试用菜单夹具
 *
 * 这里**不是**生产兜底数据 —— src/data/offline-menu.ts 已经删掉了，
 * 运行时拿不到 MCP 就报错，不会悄悄用这份数据糊弄用户。
 *
 * 这份数据只服务于单元测试：选品引擎必须能在固定输入上给出固定输出，
 * 否则"确定性"这条命题根本没法验证。字段与真实 menu 适配后的
 * RawProduct 完全一致（productId / name / price / category / available …）。
 */
import type { RawProduct } from '../../src/services/selector.service.js';

export const FIXTURE_PRODUCTS: RawProduct[] = [
  { productId: 'MOCK-BIGMAC', name: '巨无霸', price: 22.5, category: '汉堡', available: true },
  {
    productId: 'MOCK-BIGMAC-SET',
    name: '巨无霸套餐',
    price: 38.5,
    originalPrice: 45,
    category: '套餐',
    available: true,
    description: '中薯中可',
  },
  { productId: 'MOCK-BANSHAA', name: '板烧鸡腿堡', price: 19.5, category: '汉堡', available: true },
  {
    productId: 'MOCK-BANSHAA-SET',
    name: '板烧鸡腿堡套餐',
    price: 40.5,
    category: '套餐',
    available: true,
    description: '不辣',
  },
  { productId: 'MOCK-MCMCHK', name: '麦麦鸡', price: 13, category: '小食', available: true },
  { productId: 'MOCK-FILLET', name: '麦香鱼', price: 17, category: '汉堡', available: true },
  { productId: 'MOCK-WINGS', name: '麦辣鸡翅', price: 8, category: '小食', available: true, description: '辣' },
  { productId: 'MOCK-FRIES', name: '薯条（中）', price: 8.5, category: '小食', available: true },
  { productId: 'MOCK-CORN', name: '玉米杯', price: 3.75, category: '小食', available: true },
  {
    productId: 'MOCK-COKE',
    name: '可乐',
    price: 9.5,
    category: '饮料',
    available: true,
    modifications: ['去冰', '少冰', '常温'],
  },
  {
    productId: 'MOCK-LEMON',
    name: '冰鲜柠檬水',
    price: 9.5,
    category: '饮料',
    available: true,
    modifications: ['去冰', '少冰'],
  },
  { productId: 'MOCK-COCOA', name: '热可可', price: 13, category: '饮料', available: true },
  { productId: 'MOCK-COFFEE', name: '热咖啡', price: 11, category: '饮料', available: true },
  { productId: 'MOCK-TEA', name: '红茶', price: 8, category: '饮料', available: true },
  { productId: 'MOCK-SUNDAE', name: '新地（巧克力）', price: 11.5, category: '甜品', available: true },
  { productId: 'MOCK-CONE', name: '圆筒冰淇淋', price: 5, category: '甜品', available: true },
];
