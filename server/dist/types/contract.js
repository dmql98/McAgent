/**
 * 「麦门知己」前后端共享契约类型
 *
 * 规则：
 * - API 层出入参全部 camelCase
 * - DB 层列名全部 snake_case，转换在 service 层做
 * - 金额单位为元（number），保留两位小数由渲染层决定
 * - ChatReply.menu[].price 语义 = 该项小计（不是单价）
 *
 * 本文件零依赖、纯类型，可被 import type 直接使用。
 */
export {};
//# sourceMappingURL=contract.js.map