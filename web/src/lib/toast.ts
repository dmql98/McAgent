/**
 * 全局 toast
 *
 * 模块级单例：任何组件 `import { toast } from '@/lib/toast'` 就能用，
 * 不必层层 provide/inject。ToastHost 只负责渲染。
 */
import { reactive } from 'vue';

export interface ToastItem {
  id: number;
  text: string;
  bad: boolean;
}

let seq = 0;

export const toasts = reactive<ToastItem[]>([]);

export function toast(text: string, bad = false, ms = 2600): void {
  const id = ++seq;
  toasts.push({ id, text, bad });
  // 最多同时 3 条，多余的挤掉
  while (toasts.length > 3) toasts.shift();
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }, ms);
}

/** 操作成功类提示 */
export const ok = (text: string) => toast(text, false);

/** 操作失败类提示 */
export const bad = (text: string) => toast(text, true);
