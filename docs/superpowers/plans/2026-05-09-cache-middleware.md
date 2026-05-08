# Cache Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cacheMiddleware` to `@iremlopsum/apify/middleware` — an isolated, TTL-bounded, in-memory cache factory with a `clear()` escape hatch.

**Architecture:** `CacheStore` (internal utility in `src/utils/cache.ts`) provides the storage primitive with TTL expiry and oldest-first eviction. `cacheMiddleware` (in `src/built-in-middleware.ts`) wraps it into a middleware factory that checks cache before calling `next()` and stores successful results after. Each factory call creates its own isolated store.

**Tech Stack:** TypeScript, vitest — no new dependencies.

---

## File structure

```
src/utils/cache.ts              ← CREATE: CacheStore class + stableStringify (internal)
src/built-in-middleware.ts      ← MODIFY: add cacheMiddleware factory
tests/cache-middleware.test.ts  ← CREATE: unit tests (CacheStore) + integration tests (middleware)
README.md                       ← MODIFY: document cacheMiddleware in built-in middleware section
```

**Key conventions to follow:**
- All TypeScript imports use `.js` extensions even though files are `.ts` (ESM + bundler moduleResolution)
- Tests stub `fetch` inline per test with `vi.stubGlobal('fetch', ...)` and call `vi.restoreAllMocks()` in `afterEach`
- Run `npx vitest run <file>` (not `npm test`) to run a single file; add `-t "test name"` to run one test
- The `./middleware` entry point IS `src/built-in-middleware.ts` — no wiring changes needed in `package.json`

---

### Task 1: `CacheStore` utility

**Files:**
- Create: `src/utils/cache.ts`
- Create: `tests/cache-middleware.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/cache-middleware.test.ts` with the content below. These will fail because `src/utils/cache.ts` doesn't exist yet.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { CacheStore, stableStringify } from '../src/utils/cache.js'

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe('stableStringify', () => {
  it('returns null for null', () => {
    expect(stableStringify(null)).toBe('null')
  })

  it('returns null for undefined', () => {
    expect(stableStringify(undefined)).toBe('null')
  })

  it('sorts object keys alphabetically', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('sorts nested object keys', () => {
    expect(stableStringify({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}')
  })

  it('preserves array element order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles number primitives', () => {
    expect(stableStringify(42)).toBe('42')
  })

  it('handles string primitives with quoting', () => {
    expect(stableStringify('hello')).toBe('"hello"')
  })

  it('handles boolean primitives', () => {
    expect(stableStringify(true)).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

describe('CacheStore', () => {
  it('returns null for an unknown key', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    expect(store.get('missing')).toBeNull()
  })

  it('returns a stored value within TTL', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('key', { name: 'Alice' })
    expect(store.get('key')).toEqual({ name: 'Alice' })
  })

  it('returns null after TTL expires and deletes the entry', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 1000, maxSize: 10 })
    store.set('key', 'value')
    dateSpy.mockReturnValue(1001) // past TTL
    expect(store.get('key')).toBeNull()
    // confirm the entry was removed (not merely skipped)
    dateSpy.mockReturnValue(500) // back inside what would have been TTL
    expect(store.get('key')).toBeNull()
  })

  it('clears all entries', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('a', 1)
    store.set('b', 2)
    store.clear()
    expect(store.get('a')).toBeNull()
    expect(store.get('b')).toBeNull()
  })

  it('evicts the oldest entry when maxSize is reached', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 60_000, maxSize: 2 })
    store.set('a', 'first')   // timestamp 0 — oldest
    dateSpy.mockReturnValue(1)
    store.set('b', 'second')  // timestamp 1
    dateSpy.mockReturnValue(2)
    store.set('c', 'third')   // triggers eviction of 'a'
    expect(store.get('a')).toBeNull()    // evicted
    expect(store.get('b')).toBe('second')
    expect(store.get('c')).toBe('third')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/cache-middleware.test.ts
```

Expected: FAIL — `Cannot find module '../src/utils/cache.js'`

- [ ] **Step 3: Implement `src/utils/cache.ts`**

```ts
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
    if (value === null || value === undefined) return 'null'
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const pairs = Object.keys(obj).sort().map(k => `"${k}":${stableStringify(obj[k])}`)
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
   * Returns `null` if the key is not found or if the entry's age exceeds
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
  set<T>(key: string, value: T): void {
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/cache-middleware.test.ts
```

Expected: all CacheStore and stableStringify tests PASS

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/utils/cache.ts tests/cache-middleware.test.ts
git commit -m "feat: add CacheStore utility with stableStringify"
```

---

### Task 2: `cacheMiddleware` factory

**Files:**
- Modify: `src/built-in-middleware.ts`
- Modify: `tests/cache-middleware.test.ts`

- [ ] **Step 1: Append failing integration tests to `tests/cache-middleware.test.ts`**

Add these imports at the **top** of the file, merging with the existing import line:

```ts
import { describe, it, expect, vi, afterEach, vi as vitest } from 'vitest'
import { CacheStore, stableStringify } from '../src/utils/cache.js'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { cacheMiddleware } from '../src/built-in-middleware.js'
```

Add this helper function after the imports (before the first `describe`):

```ts
function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Then **append** this entire `describe` block at the end of the file:

```ts
// ---------------------------------------------------------------------------
// cacheMiddleware
// ---------------------------------------------------------------------------

describe('cacheMiddleware', () => {
  it('returns cached result on second call without hitting network', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      return mockJsonResponse({ name: 'Alice' })
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    const first = await api.getUser({ id: '1' })
    const second = await api.getUser({ id: '1' })

    expect(callCount).toBe(1)
    expect(second.data).toEqual({ name: 'Alice' })
    expect(second.error).toBeNull()
  })

  it('fetches independently for different params', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '2' })

    expect(callCount).toBe(2)
  })

  it('fetches again after TTL expires', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)

    const cache = cacheMiddleware({ ttl: 1000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    dateSpy.mockReturnValue(1001)
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('does not cache error responses', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      return new Response(null, { status: 404 })
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('does not cache network errors', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      throw new TypeError('Failed to fetch')
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('evicts oldest entry when maxSize is reached', async () => {
    const dateSpy = vi.spyOn(Date, 'now')
    let t = 0
    dateSpy.mockImplementation(() => t++)

    const responses: Record<string, string> = { '1': 'Alice', '2': 'Bob', '3': 'Carol' }
    vi.stubGlobal('fetch', async (url: string) => {
      const id = String(url).split('/').pop()!
      return mockJsonResponse({ name: responses[id] })
    })

    const cache = cacheMiddleware({ ttl: 60_000, maxSize: 2 })
    const getUser = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' }) // stored — oldest
    await api.getUser({ id: '2' }) // stored
    await api.getUser({ id: '3' }) // triggers eviction of id '1', stored

    let fetchCount = 0
    vi.stubGlobal('fetch', async () => { fetchCount++; return mockJsonResponse({ name: 'refetched' }) })

    await api.getUser({ id: '1' }) // evicted — must fetch
    await api.getUser({ id: '2' }) // still cached — no fetch
    await api.getUser({ id: '3' }) // still cached — no fetch

    expect(fetchCount).toBe(1)
  })

  it('clears all entries and fetches again', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    cache.clear()
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('logs HIT and MISS to console when debug is true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => mockJsonResponse({}))
    const cache = cacheMiddleware({ ttl: 60_000, debug: true })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' }) // MISS
    await api.getUser({ id: '1' }) // HIT

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('[apify cache] MISS'))
    expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('[apify cache] HIT'))
  })

  it('does not log when debug is omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => mockJsonResponse({}))
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('treats params with different key order as the same cache entry', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const search = new Request<{ q: string; page: number }, unknown>({
      method: 'GET',
      path: '/search',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { search } })

    await api.search({ q: 'hello', page: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await api.search({ page: 1, q: 'hello' } as any)

    expect(callCount).toBe(1)
  })

  it('two separate instances never share cache entries', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cacheA = cacheMiddleware({ ttl: 60_000 })
    const cacheB = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
    })
    const apiA = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheA] })
    const apiB = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheB] })

    await apiA.getUser({ id: '1' })
    await apiB.getUser({ id: '1' }) // different store — must fetch

    expect(callCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to confirm the new ones fail**

```bash
npx vitest run tests/cache-middleware.test.ts
```

Expected: the `cacheMiddleware` describe block FAILs with `cacheMiddleware is not a function` or similar. The CacheStore/stableStringify tests still PASS.

- [ ] **Step 3: Implement `cacheMiddleware` in `src/built-in-middleware.ts`**

At the **top** of `src/built-in-middleware.ts`, replace the existing file header comment block (lines 1–19) with the updated version (removes the "intentionally deferred" note), and add the import for CacheStore and stableStringify. Then append the `cacheMiddleware` implementation at the end of the file.

The new top of the file:

```ts
// =============================================================================
// built-in-middleware.ts — Optional, pre-built middleware utilities for apify
// =============================================================================
//
// This file ships three ready-to-use middleware functions that cover the most
// common cross-cutting concerns for HTTP clients:
//
//   1. retryMiddleware — automatically retries failed requests on server errors
//   2. logMiddleware   — logs request/response lifecycle to the console
//   3. cacheMiddleware — caches successful responses in memory with TTL
//
// These are intentionally decoupled from the core library. They are optional
// utilities that consumers can import if they want them, but the core
// (`createApi`, `Request`, `composeMiddleware`) works perfectly without them.
// =============================================================================

import type { Middleware, Result } from './types.js'
import { CacheStore, stableStringify } from './utils/cache.js'
```

Then append the following at the **end** of the file (after `logMiddleware`):

```ts
// -----------------------------------------------------------------------------
// cacheMiddleware
// -----------------------------------------------------------------------------

type CacheMiddleware = Middleware & { clear(): void }

/**
 * Creates a middleware that caches successful responses in memory, keyed by
 * request name and params. Identical calls within the TTL window are served
 * from cache without hitting the network.
 *
 * **Cache key:**
 *
 * The key is built from `ctx.requestName` and a stable JSON serialization of
 * `ctx.request.params` (object keys sorted recursively so `{ b: 2, a: 1 }`
 * and `{ a: 1, b: 2 }` are treated as the same call). This means the cache
 * key is always derived from the original params object, not the processed URL.
 *
 * **What is cached:**
 *
 * Only successful results are stored. If the response has an error (4xx, 5xx,
 * network error, or GraphQL error), the result is not cached and the next call
 * will hit the network again.
 *
 * The full `Result` object is cached, including `response` (headers, status)
 * and `retry`. Calling `retry()` on a cached result re-enters the middleware
 * chain — if the TTL is still valid it returns the cached value; if expired,
 * it makes a fresh network call. To force a network call on a specific
 * invocation, use `skipMiddleware: [myCache]` in the call options.
 *
 * **Isolation:**
 *
 * Each call to `cacheMiddleware()` creates an independent store. Two separate
 * instances on two different endpoints never share entries, regardless of
 * request name or params shape.
 *
 * **Eviction:**
 *
 * When the store reaches `maxSize`, the oldest entry by insertion time is
 * evicted before the new one is added. Expired entries are removed on access
 * rather than on a background timer.
 *
 * **Debugging:**
 *
 * Set `debug: true` to log cache hits and misses to the console:
 * ```
 * [apify cache] HIT  getUser {"id":"42"}
 * [apify cache] MISS getUser {"id":"42"}
 * ```
 *
 * @param options.ttl - Time-to-live in milliseconds. Defaults to 5 minutes.
 * @param options.maxSize - Maximum number of entries. Defaults to 50.
 * @param options.debug - Log hits and misses to console. Defaults to false.
 * @returns A middleware function with an attached `clear()` method.
 *
 * @example
 * ```ts
 * import { cacheMiddleware } from '@iremlopsum/apify/middleware'
 *
 * const getUserCache = cacheMiddleware({ ttl: 5 * 60_000, maxSize: 100 })
 *
 * const getUser = new Request<{ id: string }, User>({
 *   method: 'GET',
 *   path: '/users/:id',
 *   middleware: [getUserCache],
 * })
 *
 * // Force a network call for a single invocation:
 * const { data } = await api.getUser({ id: '42' }, { skipMiddleware: [getUserCache] })
 * ```
 *
 * @example
 * ```ts
 * // Clear all cached entries on logout so the next user gets fresh data:
 * const getUserCache = cacheMiddleware({ ttl: 5 * 60_000 })
 *
 * function onLogout() {
 *   getUserCache.clear()
 * }
 * ```
 */
export function cacheMiddleware(options?: {
  ttl?: number
  maxSize?: number
  debug?: boolean
}): CacheMiddleware {
  const store = new CacheStore({
    ttl: options?.ttl ?? 5 * 60_000,
    maxSize: options?.maxSize ?? 50,
  })
  const debug = options?.debug ?? false

  const mw: Middleware = async (ctx, next) => {
    const paramsStr = stableStringify(ctx.request.params)
    const key = `${ctx.requestName}|${paramsStr}`

    const cached = store.get<Result<unknown>>(key)
    if (cached !== null) {
      if (debug) console.log(`[apify cache] HIT  ${ctx.requestName} ${paramsStr}`)
      return cached
    }

    if (debug) console.log(`[apify cache] MISS ${ctx.requestName} ${paramsStr}`)

    const result = await next()

    if (!result.error) {
      store.set(key, result)
    }

    return result
  }

  const fn = mw as CacheMiddleware
  fn.clear = () => store.clear()
  return fn
}
```

- [ ] **Step 4: Run all tests to confirm everything passes**

```bash
npx vitest run tests/cache-middleware.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all 86 existing tests still PASS, plus the new cache tests

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/built-in-middleware.ts tests/cache-middleware.test.ts
git commit -m "feat: add cacheMiddleware with TTL, eviction, clear(), and debug logging"
```

---

### Task 3: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `cacheMiddleware` to the built-in middleware import example**

Find this line (around line 385):

```ts
import { retryMiddleware, logMiddleware } from '@iremlopsum/apify/middleware'
```

Change it to:

```ts
import { retryMiddleware, logMiddleware, cacheMiddleware } from '@iremlopsum/apify/middleware'
```

Also update the prose on the line just above it (around line 382):

From:
```
The library ships two optional middleware functions, importable from a separate entry point:
```

To:
```
The library ships three optional middleware functions, importable from a separate entry point:
```

- [ ] **Step 2: Add `cacheMiddleware` documentation block**

Find the end of the `logMiddleware` block (after the closing ` ``` ` of its code example, around line 422). Insert the following **before** `### Content types`:

````markdown
**`cacheMiddleware(options?)`**

Caches successful responses in memory, keyed by request name and params. Calls with identical params within the TTL window are served from cache without hitting the network. Each `cacheMiddleware()` call creates an isolated store — different endpoints never share entries.

```ts
const getUserCache = cacheMiddleware({ ttl: 5 * 60_000, maxSize: 100 })

const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id',
  middleware: [getUserCache],
})

// On logout — clear all cached entries:
getUserCache.clear()

// Bypass cache for a single call:
const { data } = await api.getUser({ id: '42' }, { skipMiddleware: [getUserCache] })
```

Options: `ttl` (milliseconds, default 5 min), `maxSize` (max entries, default 50), `debug` (log hits/misses to console, default false). Only successful results are cached — errors always hit the network again.

````

- [ ] **Step 3: Add `cacheMiddleware` to the API Reference table**

Find the built-in middleware table in `## API Reference` (around line 691):

```markdown
| `retryMiddleware` | function | Factory that returns middleware to retry on 5xx server errors  |
| `logMiddleware`   | const    | Middleware that logs request lifecycle to the console          |
```

Add a row after `logMiddleware`:

```markdown
| `cacheMiddleware` | function | Factory that returns a per-request in-memory cache with `clear()` |
```

- [ ] **Step 4: Run the full test suite and typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: all tests PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document cacheMiddleware in README"
```

---

## Self-review

**Spec coverage:**
- ✅ `CacheStore` in `src/utils/cache.ts` — Task 1
- ✅ `stableStringify` — Task 1
- ✅ TTL expiry on access — Task 1
- ✅ Oldest-first eviction — Task 1
- ✅ `cacheMiddleware` factory — Task 2
- ✅ Isolation (per-instance store) — Task 2
- ✅ Only caches successes — Task 2
- ✅ Full `Result` stored — Task 2
- ✅ `clear()` method — Task 2
- ✅ `debug` logging (HIT/MISS with requestName and params) — Task 2
- ✅ Header comment updated (removes "intentionally deferred" note) — Task 2
- ✅ JSDoc on `cacheMiddleware` matching existing verbosity — Task 2
- ✅ All 10 test scenarios from spec — Task 2
- ✅ README section + API Reference row — Task 3

**Type consistency:** `CacheStore`, `stableStringify`, `CacheMiddleware` all defined in Task 1/2 and referenced consistently in Task 2/3. `Result<unknown>` used for the generic on `store.get<Result<unknown>>(key)` — matches what `next()` returns.

**No placeholders:** Every step has complete code.
