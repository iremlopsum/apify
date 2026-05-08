# Cache Middleware Implementation Design

## Goal

Add `cacheMiddleware` to the `@iremlopsum/apify/middleware` entry point — a per-request, TTL-bounded, read-through cache delivered as a middleware factory. Joins `retryMiddleware` and `logMiddleware` as a built-in optional utility.

## Architecture

Two pieces: an internal `CacheStore` class and the `cacheMiddleware` factory.

```
src/utils/cache.ts          ← CacheStore (internal, not exported from public API)
src/built-in-middleware.ts  ← cacheMiddleware factory (exported from ./middleware)
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

Each entry stores `{ data: Result<unknown>, timestamp: number }`. On `get()`, if `Date.now() - entry.timestamp >= ttl`, the entry is deleted and `null` is returned. No background timer — expired entries are cleaned up on access.

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

```ts
const getUserCache = cacheMiddleware({ ttl: 60_000 })
const getUser = new Request({ method: 'GET', path: '/users/:id', middleware: [getUserCache] })

// On logout:
getUserCache.clear()
```

### `debug` logging

When `debug: true`, the middleware logs to `console.log` with the `[apify cache]` prefix:

```
[apify cache] HIT  getUser {"id":"42"}
[apify cache] MISS getUser {"id":"42"}
```

The second segment is the `requestName`. The third is the stable-stringified params. No logging when `debug` is omitted or `false`.

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

| Scenario | Assertion |
| --- | --- |
| Same params called twice | `fetch` called once; second call returns stored result |
| Different params | Both calls hit network independently |
| TTL expiry (mock `Date.now()`) | Expired entry not returned; network called again |
| Error response (4xx/5xx) | Not stored; second call hits network |
| `maxSize` eviction | Oldest entry evicted when limit reached; new entry stored |
| `clear()` | Next call hits network even within TTL |
| `debug: true` | `console.log` called with HIT/MISS, name, params |
| `debug` omitted | `console.log` not called |
| Params in different key order | Treated as cache hit (stable key) |
| Two separate middleware instances | Never share entries |

## Exports

`cacheMiddleware` is added to `src/built-in-middleware.ts` and re-exported from the `./middleware` entry point. `CacheStore` is not exported. No changes to the core `src/index.ts`.
