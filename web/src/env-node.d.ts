/**
 * Vite 配置在 Node 侧执行，需要一点最小化的环境类型。
 * 只声明实际用到的，不引 @types/node（避免 Node 全局污染浏览器端代码）。
 */
interface ImportMeta {
  readonly dirname: string;
  readonly url: string;
}
