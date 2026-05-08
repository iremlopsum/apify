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

// -----------------------------------------------------------------------------
// retryMiddleware
// -----------------------------------------------------------------------------

/**
 * Creates a middleware that automatically retries requests when the server
 * returns a 5xx (server error) status code.
 *
 * **How it works:**
 *
 * When the downstream middleware chain (via `next()`) returns a result with
 * an error whose status is >= 500, this middleware calls `next()` again,
 * effectively re-executing every middleware below it in the onion plus the
 * core fetch. It keeps retrying until either:
 *
 *   - The request succeeds (any non-error result), OR
 *   - The maximum number of retries has been exhausted.
 *
 * **What it does NOT retry:**
 *
 * - 4xx errors (client errors like 400, 401, 403, 404) — these are caused
 *   by the request itself, not transient server issues, so retrying would
 *   just produce the same error.
 * - Network errors (status 0) — these could be retried, but that's left
 *   to the consumer to decide via a custom middleware.
 *
 * **Retry count semantics:**
 *
 * `maxRetries` is the number of ADDITIONAL attempts after the initial one.
 * So `retryMiddleware(2)` means: 1 initial attempt + up to 2 retries = 3
 * total calls to `next()` in the worst case.
 *
 * **Middleware position matters:**
 *
 * Because `next()` re-executes everything downstream, placing retry
 * middleware BEFORE auth middleware means auth headers will be re-injected
 * on each retry (good). Placing it AFTER means the same headers are reused
 * (usually fine, but stale tokens won't be refreshed).
 *
 * @param maxRetries - Maximum number of retry attempts after the initial
 *   request. Defaults to 3 if not specified.
 * @returns A Middleware function that can be passed to `createApi` or
 *   individual `Request` configs.
 *
 * @example
 * ```ts
 * // Retry up to 2 times on server errors (3 total attempts)
 * const api = createApi({
 *   baseUrl: '/api',
 *   requests: { getItems },
 *   middleware: [retryMiddleware(2)],
 * })
 * ```
 */
export function retryMiddleware(maxRetries = 3): Middleware {
  // Return the actual middleware function. The `maxRetries` value is captured
  // in the closure, so each call to `retryMiddleware(n)` produces a unique
  // middleware instance with its own retry limit.
  return async (ctx, next) => {
    // Make the initial request by calling next(). This traverses all
    // downstream middleware and eventually hits the core fetch function.
    let result = await next()

    // Track how many retry attempts we've made so far. This counter is
    // local to each individual API call — concurrent requests each get
    // their own counter.
    let attempts = 0

    // Keep retrying as long as ALL three conditions are true:
    //   1. The result has an error (the request failed)
    //   2. The error status is a server error (5xx range)
    //   3. We haven't exhausted our retry budget
    //
    // If ANY condition is false, we break out and return whatever result
    // we have — whether it's a success or an unretryable error.
    while (result.error && result.error.status >= 500 && attempts < maxRetries) {
      // Increment the attempt counter BEFORE retrying, so we don't
      // accidentally exceed the limit.
      attempts++

      // Call next() again to re-execute the downstream chain. This creates
      // a completely fresh request through all middleware below this one.
      // The context object is the same (so any mutations from previous
      // passes are preserved), but the fetch is brand new.
      result = await next()
    }

    // Return the final result — either the first successful response,
    // the last failed response after exhausting retries, or the original
    // error if it wasn't a 5xx (loop never entered).
    return result
  }
}

// -----------------------------------------------------------------------------
// logMiddleware
// -----------------------------------------------------------------------------

/**
 * Middleware that logs the lifecycle of each API request to the console.
 *
 * **What it logs:**
 *
 * 1. A "request start" line when the request begins, showing the HTTP method,
 *    the request name (e.g., 'getUser'), and the full URL.
 *
 * 2. A "request complete" line when the response arrives, showing:
 *    - The request name
 *    - Whether it succeeded ("OK") or failed ("ERROR" + status code)
 *    - The elapsed time in milliseconds
 *
 * **Timing:**
 *
 * Uses `Date.now()` instead of `performance.now()` for maximum runtime
 * compatibility. `performance.now()` is not available in all environments
 * (e.g., some edge runtimes, older Node.js versions), while `Date.now()`
 * works everywhere. The millisecond precision of `Date.now()` is more than
 * sufficient for HTTP request timing.
 *
 * **Output format examples:**
 *
 * ```
 * [apify] → GET getItems /api/items
 * [apify] ← getItems OK (142ms)
 *
 * [apify] → POST createUser /api/users
 * [apify] ← createUser ERROR 422 (89ms)
 * ```
 *
 * **Usage note:**
 *
 * This middleware is intended for development and debugging. In production,
 * you may want to replace it with a custom middleware that sends telemetry
 * to your observability platform instead of logging to the console.
 *
 * @example
 * ```ts
 * import { logMiddleware } from 'apify/middleware'
 *
 * const api = createApi({
 *   baseUrl: '/api',
 *   requests: { getItems, createUser },
 *   middleware: [logMiddleware],
 * })
 * ```
 */
export const logMiddleware: Middleware = async (ctx, next) => {
  // Capture the start time BEFORE calling next(). We use Date.now() which
  // returns milliseconds since epoch — simple, universal, good enough for
  // HTTP request timing.
  const start = Date.now()

  // Log the outgoing request. The format includes the HTTP method, the
  // request name (which is the key in the `requests` object passed to
  // createApi), and the fully resolved URL.
  console.log(`[apify] → ${ctx.request.method} ${ctx.requestName} ${ctx.request.url}`)

  // Execute the downstream middleware chain and the core fetch.
  const result = await next()

  // Calculate how long the entire downstream chain took. This includes
  // all inner middleware processing time plus the actual HTTP round-trip.
  const duration = Date.now() - start

  // Log the result. We differentiate between errors and successes so
  // developers can quickly scan logs for problems.
  if (result.error) {
    // Error path: include the HTTP status code so developers can see
    // whether it's a client error (4xx) or server error (5xx).
    console.log(`[apify] ← ${ctx.requestName} ERROR ${result.error.status} (${duration}ms)`)
  } else {
    // Success path: just "OK" with timing — the status code (200, 201, etc.)
    // is less interesting when things work correctly.
    console.log(`[apify] ← ${ctx.requestName} OK (${duration}ms)`)
  }

  // Return the result unchanged. This middleware is purely observational —
  // it never modifies the request or the response.
  return result
}

// -----------------------------------------------------------------------------
// cacheMiddleware
// -----------------------------------------------------------------------------

export type CacheMiddleware = Middleware & { clear(): void }

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
