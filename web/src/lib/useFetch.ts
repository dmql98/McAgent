/**
 * 「拉一个区块」的组合式函数
 *
 * 每个面板都是这个形状：loading → 调接口 → 得到数据或错误 → 可重试。
 * 抽出来是为了让面板代码只关心「数据长什么样、怎么画」，
 * 而不是每个都重写一遍 try/catch/finally。
 */
import { onMounted, ref, shallowRef, type Ref } from 'vue';
import { messageOf } from './error';

export interface Fetcher<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<unknown>;
  /** 首次是否已跑完（用来区分「还没拉」和「拉完是空的」） */
  loaded: Ref<boolean>;
  reload: () => Promise<void>;
}

export function useFetch<T>(
  fn: () => Promise<T>,
  opts: { immediate?: boolean; onError?: (e: unknown) => void } = {},
): Fetcher<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<unknown>(undefined);
  const loaded = ref(false);

  let seq = 0;

  async function reload(): Promise<void> {
    const my = ++seq;
    loading.value = true;
    error.value = undefined;
    try {
      const r = await fn();
      // 竞态保护：快速点两次刷新时只认最后一次
      if (my !== seq) return;
      data.value = r;
      loaded.value = true;
    } catch (e) {
      if (my !== seq) return;
      error.value = e;
      opts.onError?.(e);
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  if (opts.immediate !== false) onMounted(() => void reload());

  return { data, loading, error, loaded, reload };
}

/** 把错误转成可显示文案（模板里用） */
export function errText(e: unknown): string {
  return messageOf(e);
}

/** 地址里带的一个查询参数（有些面板需要 ?date= / ?code=） */
export function queryParam(name: string): string {
  return new URLSearchParams(location.search).get(name) ?? '';
}
