/**
 * TTL 缓存：纯逻辑、零依赖、可单测
 * - 惰性过期 + 定时清理
 * - 容量上限按最旧淘汰
 * - 命中率统计
 */
export interface TtlCacheOptions {
  maxSize: number;
  defaultTtlMs: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  createdAt: number;
}

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private opts: TtlCacheOptions) {
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return e.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.opts.defaultTtlMs;
    const now = Date.now();

    if (this.map.size >= this.opts.maxSize && !this.map.has(key)) {
      // 先清过期，还满就淘汰最旧的
      this.sweep();
      if (this.map.size >= this.opts.maxSize) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, e] of this.map) {
          if (e.createdAt < oldestAt) {
            oldestAt = e.createdAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.map.delete(oldestKey);
      }
    }

    this.map.set(key, { value, expiresAt: now + ttl, createdAt: now });
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (now > e.expiresAt) this.map.delete(k);
    }
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 1000,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.map.clear();
  }
}
