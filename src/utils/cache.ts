// =============================================================================
// cache.ts — In-memory cache store for cacheMiddleware
// =============================================================================

interface CacheEntry {
  value: unknown
  timestamp: number
}

/**
 * Produces a stable JSON string representation with sorted object keys.
 *
 * Object key order in JavaScript is not guaranteed to be consistent, so
 * `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` could serialize differently with
 * `JSON.stringify`. This function normalises by sorting keys recursively,
 * so both produce `{"a":1,"b":2}`.
 *
 * Array element order is preserved — `[1, 2]` and `[2, 1]` are treated
 * as different values.
 *
 * Never throws — serialization errors (e.g., circular references) return
 * a sentinel string rather than propagating the exception.
 */
export function stableStringify(value: unknown): string {
  try {
    if (value === undefined) return '[undefined]'
    if (value === null) return 'null'
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const pairs = Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      return `{${pairs.join(',')}}`
    }
    return JSON.stringify(value)
  } catch {
    return `[SERIALIZATION_ERROR:${typeof value}]`
  }
}

/**
 * In-memory cache store for `cacheMiddleware`. Stores values by string key
 * with TTL-based expiry and oldest-first eviction when the store is full.
 *
 * Each entry is stamped with an insertion timestamp. On `get()`, if the
 * entry is older than `ttl` milliseconds, it is deleted and `null` is
 * returned. On `set()`, if the store has reached `maxSize`, the entry with
 * the lowest insertion timestamp is evicted before the new one is added.
 *
 * This is NOT a true LRU cache — eviction is by insertion time, not by
 * last access time. For the small cache sizes this class is designed for
 * (default: 50 entries), the distinction is rarely meaningful in practice.
 *
 * @example
 * ```ts
 * const store = new CacheStore({ ttl: 60_000, maxSize: 50 })
 * store.set('getUser|{"id":"1"}', responseResult)
 * store.get('getUser|{"id":"1"}') // → responseResult (within TTL)
 * store.clear()
 * store.get('getUser|{"id":"1"}') // → null
 * ```
 */
export class CacheStore {
  private cache = new Map<string, CacheEntry>()
  private readonly ttl: number
  private readonly maxSize: number

  constructor(options: { ttl: number; maxSize: number }) {
    this.ttl = options.ttl
    this.maxSize = options.maxSize
  }

  /**
   * Retrieves a cached value if it exists and hasn't expired.
   *
   * Returns `null` if the key is not found or if the entry's age reaches or exceeds
   * the configured TTL. Expired entries are deleted from the store on access
   * rather than on a background timer.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp >= this.ttl) {
      this.cache.delete(key)
      return null
    }
    return entry.value as T
  }

  /**
   * Stores a value under the given key with the current timestamp.
   *
   * If the store has reached `maxSize`, the entry with the oldest insertion
   * timestamp is evicted before the new entry is added. Eviction is O(n) —
   * acceptable because `maxSize` is designed to be small (≤ 200).
   */
  set(key: string, value: unknown): void {
    if (this.maxSize === 0) return
    if (this.cache.size >= this.maxSize) {
      let oldestKey: string | null = null
      let oldestTimestamp = Infinity
      for (const [k, entry] of this.cache) {
        if (entry.timestamp < oldestTimestamp) {
          oldestTimestamp = entry.timestamp
          oldestKey = k
        }
      }
      if (oldestKey !== null) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { value, timestamp: Date.now() })
  }

  /**
   * Removes all entries from the store immediately.
   *
   * Useful for invalidating the entire cache — for example, on user logout
   * to prevent the next user from seeing stale data.
   */
  clear(): void {
    this.cache.clear()
  }
}
