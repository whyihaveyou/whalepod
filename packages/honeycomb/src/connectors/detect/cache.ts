/**
 * Detection cache with TTL expiry and invalidation.
 *
 * Detection is the slowest part of the connector lifecycle (subprocess
 * version probes, filesystem walks), so results are memoized for a bounded
 * window. Manual re-registration and explicit invalidations bypass the cache.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

/** A cached value together with its expiry timestamp. */
interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Bounded TTL cache for detection results.
 *
 * @typeParam T - the cached value type (e.g. `AgentDescriptor | null`).
 */
export class DetectionCache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>()

  constructor(
    /** Time-to-live in milliseconds for each entry. */
    private readonly ttlMs: number,
    /** Clock used for expiry (injectable for tests). */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read a cached value if present and unexpired.
   * @returns the cached value, or `undefined` on miss or expiry.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  /**
   * Store a value with a fresh expiry.
   */
  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  /**
   * Invalidate a single key or (with no argument) the entire cache.
   */
  invalidate(key?: string): void {
    if (key === undefined) this.store.clear()
    else this.store.delete(key)
  }

  /** Number of currently-held entries (including unexpired and stale). */
  get size(): number {
    return this.store.size
  }
}
