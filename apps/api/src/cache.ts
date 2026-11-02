/**
 * A small in-process TTL cache. Values are immutable; callers must not mutate
 * a value they get back while it may still be cached.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 1_000;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
