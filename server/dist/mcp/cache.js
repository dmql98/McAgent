export class TtlCache {
    opts;
    map = new Map();
    hits = 0;
    misses = 0;
    sweeper = null;
    constructor(opts) {
        this.opts = opts;
        this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
        this.sweeper.unref?.();
    }
    get(key) {
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
    has(key) {
        return this.get(key) !== undefined;
    }
    set(key, value, ttlMs) {
        const ttl = ttlMs ?? this.opts.defaultTtlMs;
        const now = Date.now();
        if (this.map.size >= this.opts.maxSize && !this.map.has(key)) {
            // 先清过期，还满就淘汰最旧的
            this.sweep();
            if (this.map.size >= this.opts.maxSize) {
                let oldestKey = null;
                let oldestAt = Infinity;
                for (const [k, e] of this.map) {
                    if (e.createdAt < oldestAt) {
                        oldestAt = e.createdAt;
                        oldestKey = k;
                    }
                }
                if (oldestKey)
                    this.map.delete(oldestKey);
            }
        }
        this.map.set(key, { value, expiresAt: now + ttl, createdAt: now });
    }
    delete(key) {
        return this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    sweep() {
        const now = Date.now();
        for (const [k, e] of this.map) {
            if (now > e.expiresAt)
                this.map.delete(k);
        }
    }
    stats() {
        const total = this.hits + this.misses;
        return {
            size: this.map.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 1000,
        };
    }
    resetStats() {
        this.hits = 0;
        this.misses = 0;
    }
    dispose() {
        if (this.sweeper)
            clearInterval(this.sweeper);
        this.sweeper = null;
        this.map.clear();
    }
}
//# sourceMappingURL=cache.js.map