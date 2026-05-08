# Cache Middleware Implementation Design

## Goal

Add `cacheMiddleware` to the `@iremlopsum/apify/middleware` entry point — a per-request, TTL-bounded, read-through cache delivered as a middleware factory. Joins `retryMiddleware` and `logMiddleware` as a built-in optional utility.

## Architecture

Two pieces: an internal `CacheStore` class and the `cacheMiddleware` factory.

```
src/utils/cache.ts          ← CacheStore (internal, not exported from public API)
src/built-in-middleware.ts  ← cacheMiddleware factory (exported from ./middleware)
tests/cache-middleware.test.ts ← test suite
```

This mirrors the existing pattern where `DedupeTracker` lives in `src/utils/dedupe.ts` and is consumed by `create-api.ts` without being part of the public surface.

## CacheStore

An internal class. Never exported from `src/index.ts` or `src/built-in-middleware.ts`.

```ts
class CacheStore {
  constructor(options: { ttl: number; maxSize: number })
  get<T>(key: string): T | null
  set<T>(key: string, data: T): void
  clear(): void
}
```

### Key generation

Key generation is the middleware's responsibility, not the store's. `CacheStore.get/set` accept a pre-built string key. The middleware builds it as:

```
key = ctx.requestName + "|" + stableStringify(ctx.request.params)
```

`stableStringify` is a private method on `CacheStore`:
- Recursively sorts object keys so `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` produce the same key
- Preserves array element order (different orderings are distinct values)
- Falls back to a `[SERIALIZATION_ERROR:<type>]` sentinel on error rather than throwing

### TTL and expiry

Each entry stores `{ value: Result<unknown>, timestamp: number }`. On `get()`, if `Date.now() - entry.timestamp >= ttl`, the entry is deleted and `null` is returned. No background timer — expired entries are cleaned up on access.

### Eviction

When `set()` is called and `cache.size >= maxSize`, the entry with the lowest insertion timestamp is evicted before the new entry is added. This is oldest-first eviction (not true LRU — no "last accessed" timestamp is maintained). O(n) scan, acceptable for the small `maxSize` values this is designed for.

## `cacheMiddleware` factory

### Signature

```ts
type CacheMiddleware = Middleware & { clear(): void }

function cacheMiddleware(options?: {
  ttl?: number      // milliseconds — default: 5 * 60 * 1000 (5 minutes)
  maxSize?: number  // max entries — default: 50
  debug?: boolean   // log hits/misses to console — default: false
}): CacheMiddleware
```

Exported from `src/built-in-middleware.ts`. Re-exported from the `./middleware` entry point.

### Isolation

Each call to `cacheMiddleware()` creates a new `CacheStore` instance. Two separate `cacheMiddleware()` calls on two different endpoints never share state, regardless of `requestName` or params shape. No cross-endpoint collision risk.

### Middleware flow

On each invocation:

1. Build key from `ctx.requestName` and `ctx.request.params`
2. Call `store.get(key)` — if hit, optionally log, return the cached `Result` directly
3. Call `next()` to execute the downstream chain
4. If `!result.error`, call `store.set(key, result)` to cache the full `Result` object
5. Optionally log the miss
6. Return `result`

### What is cached

The full `Result<unknown>` object is stored — including `data`, `error` (always `null` on a store write), `response`, and `retry`. This preserves response headers and status on cache hits.

**Errors are never cached.** If `result.error` is set (4xx, 5xx, network error, or GraphQL error), the result is not stored. The next call will attempt the network again.

### `retry()` on a cache hit

`retry()` re-enters the middleware chain from the outermost layer. If the cache entry is still valid when `retry()` runs, it returns the cached value. If the TTL has expired, it makes a fresh network call. Users who want to force a network bypass can use `skipMiddleware: [myCache]` via the existing per-call mechanism.

### `clear()`

Attached directly to the middleware function object (`fn.clear = () => store.clear()`). Empties the underlying `CacheStore` immediately. All subsequent calls hit the network until new entries are stored.

### `debug` logging

When `debug: true`, the middleware logs to `console.log` with the `[apify cache]` prefix:

```
[apify cache] HIT  getUser {"id":"42"}
[apify cache] MISS getUser {"id":"42"}
```

The second segment is the `requestName`. The third is the stable-stringified params. No logging when `debug` is omitted or `false`.

## JSDoc

The JSDoc for `cacheMiddleware` must match the level of detail in `retryMiddleware` and `logMiddleware`. Include: what it does, how the cache key is built, what gets cached and what doesn't, eviction behavior, how `clear()` works, how `debug` works, a note on isolation, a note on `retry()` behavior on cache hits, and two `@example` blocks (basic usage and `clear()` on logout).

Write it as:

```ts
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
```

## Usage examples

### REST

```ts
import { cacheMiddleware } from '@iremlopsum/apify/middleware'

const getUserCache = cacheMiddleware({ ttl: 5 * 60_000, maxSize: 100 })

const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id',
  middleware: [getUserCache],
})

// On logout:
getUserCache.clear()
```

### GraphQL

```ts
const viewerCache = cacheMiddleware({ ttl: 60_000 })

const getViewer = new Operation<Record<string, never>, Viewer>({
  operation: GET_VIEWER,
  middleware: [viewerCache],
})
```

### Force network bypass for a single call

```ts
const { data } = await api.getUser({ id: '42' }, { skipMiddleware: [getUserCache] })
```

## What is NOT included

- **Shared cache instances** — each `cacheMiddleware()` call creates its own store. No cross-endpoint sharing.
- **Cache invalidation by key** — TTL and `clear()` are the only expiry mechanisms.
- **Stale-while-revalidate** — not supported.
- **Persistence** — in-memory only, no localStorage or IndexedDB integration.
- **Response body re-parsing** — the full `Result` is stored; `response.body` is already consumed and not re-read.

## Tests

Test file: `tests/cache-middleware.test.ts`

Follow the existing test conventions: `vi.stubGlobal('fetch', ...)` inline per test, `vi.restoreAllMocks()` in `afterEach`. Define `mockJsonResponse` and `mockNetworkError` helpers at the top of the file.

### Cache hit / miss

```ts
it('returns cached result on second call without hitting network', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => {
    callCount++
    return mockJsonResponse({ name: 'Alice' })
  })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, { name: string }>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  const first = await api.getUser({ id: '1' })
  const second = await api.getUser({ id: '1' })

  expect(callCount).toBe(1)
  expect(second.data).toEqual({ name: 'Alice' })
})

it('fetches independently for different params', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  await api.getUser({ id: '2' })

  expect(callCount).toBe(2)
})
```

### TTL expiry

```ts
it('fetches again after TTL expires', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
  const dateSpy = vi.spyOn(Date, 'now')
  dateSpy.mockReturnValue(0)

  const cache = cacheMiddleware({ ttl: 1000 })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  dateSpy.mockReturnValue(1001) // past TTL
  await api.getUser({ id: '1' })

  expect(callCount).toBe(2)
})
```

### Errors not cached

```ts
it('does not cache error responses', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => {
    callCount++
    return new Response(null, { status: 404 })
  })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  await api.getUser({ id: '1' })

  expect(callCount).toBe(2)
})

it('does not cache network errors', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; throw new TypeError('Failed to fetch') })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  await api.getUser({ id: '1' })

  expect(callCount).toBe(2)
})
```

### maxSize eviction

```ts
it('evicts oldest entry when maxSize is reached', async () => {
  const responses: Record<string, string> = { '1': 'Alice', '2': 'Bob', '3': 'Carol' }
  vi.stubGlobal('fetch', async (url: string) => {
    const id = (url as string).split('/').pop()!
    return mockJsonResponse({ name: responses[id] })
  })
  const cache = cacheMiddleware({ ttl: 60_000, maxSize: 2 })
  const getUser = new Request<{ id: string }, { name: string }>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' }) // stored (oldest)
  await api.getUser({ id: '2' }) // stored
  await api.getUser({ id: '3' }) // triggers eviction of id '1', stored

  let fetchCount = 0
  vi.stubGlobal('fetch', async () => { fetchCount++; return mockJsonResponse({ name: 'Alice' }) })

  await api.getUser({ id: '1' }) // evicted — must fetch
  await api.getUser({ id: '2' }) // still cached — no fetch
  await api.getUser({ id: '3' }) // still cached — no fetch

  expect(fetchCount).toBe(1)
})
```

### `clear()`

```ts
it('clears all entries and fetches again', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  cache.clear()
  await api.getUser({ id: '1' })

  expect(callCount).toBe(2)
})
```

### `debug` logging

```ts
it('logs HIT and MISS when debug is true', async () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', async () => mockJsonResponse({}))
  const cache = cacheMiddleware({ ttl: 60_000, debug: true })
  const getUser = new Request<{ id: string }, unknown>({
    method: 'GET', path: '/users/:id', middleware: [cache],
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
    method: 'GET', path: '/users/:id', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { getUser } })

  await api.getUser({ id: '1' })
  await api.getUser({ id: '1' })

  expect(logSpy).not.toHaveBeenCalled()
})
```

### Stable key / param order

```ts
it('treats params with different key order as the same cache entry', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
  const cache = cacheMiddleware({ ttl: 60_000 })
  const search = new Request<{ q: string; page: number }, unknown>({
    method: 'GET', path: '/search', middleware: [cache],
  })
  const api = createApi({ baseUrl: '', requests: { search } })

  await api.search({ q: 'hello', page: 1 })
  await api.search({ page: 1, q: 'hello' } as any) // different insertion order

  expect(callCount).toBe(1)
})
```

### Isolation between instances

```ts
it('two cacheMiddleware instances do not share entries', async () => {
  let callCount = 0
  vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
  const cacheA = cacheMiddleware({ ttl: 60_000 })
  const cacheB = cacheMiddleware({ ttl: 60_000 })
  const getUser = new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id' })
  const apiA = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheA] })
  const apiB = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheB] })

  await apiA.getUser({ id: '1' })
  await apiB.getUser({ id: '1' }) // different store — must fetch

  expect(callCount).toBe(2)
})
```

## Exports

`cacheMiddleware` is added to `src/built-in-middleware.ts` and re-exported from the `./middleware` entry point. `CacheStore` is not exported. No changes to the core `src/index.ts`.
