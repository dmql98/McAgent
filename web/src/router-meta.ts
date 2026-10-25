/** 导航显示信息 */
export interface NavItem {
  name: string;
  label: string;
  /** 图标名，对应 AppIcon 的 name */
  icon: string;
  group: NavGroup;
  title: string;
  /** 页面关联的工具 */
  tools?: string[];
}

export type NavGroup = '点餐' | '我的账户' | '更多服务' | '开发工具';

export const NAV_GROUPS: NavGroup[] = ['点餐', '我的账户', '更多服务', '开发工具'];

export const NAV_ITEMS: NavItem[] = [
  { name: 'overview', label: '总览', icon: 'overview', group: '点餐', title: '总览' },
  {
    name: 'chat', label: '对话点餐', icon: 'chat', group: '点餐', title: '对话点餐',
    tools: ['query-nearby-stores', 'query-meals', 'available-coupons', 'calculate-price', 'create-order'],
  },
  {
    name: 'stores', label: '找门店', icon: 'pin', group: '点餐', title: '找门店',
    tools: ['query-nearby-stores', 'query-store-detail', 'query-city', 'now-time-info', 'query-store-coupons'],
  },
  {
    name: 'menu', label: '门店菜单', icon: 'burger', group: '点餐', title: '门店菜单',
    tools: ['query-meals', 'query-meal-detail', 'query-meal-price', 'calculate-price', 'query-meal-calories'],
  },
  {
    name: 'cart', label: '价格试算', icon: 'calc', group: '点餐', title: '价格试算',
    tools: ['calculate-price', 'query-meal-price'],
  },
  {
    name: 'nutrition', label: '营养表', icon: 'leaf', group: '点餐', title: '营养表',
    tools: ['list-nutrition-foods', 'query-meal-calories'],
  },
  {
    name: 'orders', label: '订单记录', icon: 'receipt', group: '我的账户', title: '订单记录',
    tools: ['order-list', 'query-order', 'cancel-order', 'query-survey-coupon', 'mall-order-list', 'mall-order-detail'],
  },
  {
    name: 'coupons', label: '我的券包', icon: 'ticket', group: '我的账户', title: '我的券包',
    tools: ['query-my-coupons', 'available-coupons', 'query-store-coupons', 'auto-bind-coupons'],
  },
  {
    name: 'addresses', label: '外送地址', icon: 'home', group: '我的账户', title: '外送地址',
    tools: ['delivery-query-addresses', 'delivery-create-address'],
  },
  { name: 'memory', label: '偏好设置', icon: 'user', group: '我的账户', title: '偏好设置' },
  {
    name: 'points', label: '积分与抽奖', icon: 'star', group: '更多服务', title: '积分与抽奖',
    tools: ['query-my-account', 'query-lottery-info', 'draw-lottery', 'query-my-prizes'],
  },
  {
    name: 'mall', label: '积分商城', icon: 'gift', group: '更多服务', title: '积分商城',
    tools: ['mall-points-products', 'mall-product-detail', 'mall-create-order', 'mall-points-rules'],
  },
  {
    name: 'campaigns', label: '活动日历', icon: 'calendar', group: '更多服务', title: '活动日历',
    tools: ['campaign-calendar', 'campaign-detail'],
  },
  {
    name: 'parties', label: '派对预约', icon: 'sparkle', group: '更多服务', title: '派对预约',
    tools: ['query-party-city', 'query-party-store', 'query-party-store-date', 'query-party-store-session', 'party-order-create'],
  },
  { name: 'tools', label: '工具台', icon: 'tools', group: '开发工具', title: '工具台' },
];

export function navByGroup(): Array<{ name: NavGroup; items: NavItem[] }> {
  return NAV_GROUPS.map((g) => ({ name: g, items: NAV_ITEMS.filter((i) => i.group === g) })).filter(
    (g) => g.items.length > 0,
  );
}
