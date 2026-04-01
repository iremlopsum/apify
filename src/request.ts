// =============================================================================
// request.ts — Typed request definition class for the apify library
// =============================================================================
//
// This file defines the `Request` class, which is the primary way to declare
// an API endpoint in the library. Each endpoint (e.g., "get user", "create item")
// is represented by a single `Request` instance that holds the endpoint's
// configuration (method, path, headers, middleware, etc.).
//
// IMPORTANT: The Request class is a *typed config container* — it does NOT
// execute HTTP requests on its own. Execution is handled by the API client
// returned from `createApi`. The Request class simply stores the "recipe" for
// how a particular endpoint should be called.
//
// Why is this a class and not a plain object?
// 1. The class provides a clear type signature with TParams and TResponse
//    generics, which allows createApi to infer the correct param/return types
//    for each API method automatically.
// 2. The `shouldSerializeAsQuery` getter encapsulates serialization logic
//    in one place, rather than spreading it across the fetch layer.
// 3. Future extensibility — if we need to add methods (e.g., `clone()`,
//    `withMiddleware()`) they live naturally on the class.
//
// Usage:
// ```ts
// const getUser = new Request<{ id: string }, User>({
//   method: 'GET',
//   path: '/users/:id',
// })
//
// const createUser = new Request<{ name: string; email: string }, User>({
//   method: 'POST',
//   path: '/users',
//   middleware: [validationMiddleware],
// })
// ```
// =============================================================================

import type { RequestConfig } from './types.js'

// ---------------------------------------------------------------------------
// HTTP methods that default to query string serialization.
// GET and DELETE traditionally send parameters via the URL (query string),
// while POST, PUT, and PATCH send parameters in the request body.
// This set is used by the `shouldSerializeAsQuery` getter to determine
// the default behavior when `bodyAs` is not explicitly set.
// ---------------------------------------------------------------------------
const QUERY_METHODS = new Set(['GET', 'DELETE'])

/**
 * Typed request definition. One instance per API endpoint.
 *
 * The `Request` class is a **typed config container** — it does **not** execute
 * HTTP requests. Execution is handled by the API client returned from `createApi`.
 * This class stores the "recipe" for how a particular endpoint should be called:
 * which HTTP method, what path template, which middleware to apply, what headers
 * to include, and how to serialize parameters.
 *
 * The two type parameters are the key to the library's type safety:
 * - `TParams` describes what the caller must pass when invoking this endpoint.
 * - `TResponse` describes what the caller receives back on success.
 *
 * When passed to `createApi`, these generics flow through to produce a fully
 * typed API method: `api.getUser({ id: '42' })` → `Promise<Result<User>>`.
 *
 * @typeParam TParams - The shape of the params object the caller must provide.
 *   This includes both path parameters (e.g., `:id` segments) and any query
 *   string or body parameters. Path params are extracted and substituted
 *   automatically; the rest are serialized according to the method or `bodyAs`.
 *
 * @typeParam TResponse - The shape of the successful response data. This
 *   becomes the type of `result.data` when the API call succeeds.
 *
 * @example
 * ```ts
 * // Define a GET endpoint that takes an `id` path param and returns a User
 * const getUser = new Request<{ id: string }, User>({
 *   method: 'GET',
 *   path: '/users/:id',
 * })
 *
 * // Define a POST endpoint with middleware and custom headers
 * const createUser = new Request<{ name: string; email: string }, User>({
 *   method: 'POST',
 *   path: '/users',
 *   middleware: [validationMiddleware],
 *   headers: { 'X-Idempotency-Key': crypto.randomUUID() },
 * })
 *
 * // Define a DELETE endpoint that sends a JSON body (overriding the default
 * // query string behavior for DELETE)
 * const bulkDelete = new Request<{ ids: string[] }, { deleted: number }>({
 *   method: 'DELETE',
 *   path: '/items',
 *   bodyAs: 'body',
 * })
 * ```
 */
export class Request<TParams extends object, TResponse> {
  /**
   * The immutable configuration for this endpoint.
   *
   * Contains the HTTP method, URL path template, optional middleware,
   * headers, response parsing strategy, deduplication flag, and body
   * serialization override.
   *
   * This property is `readonly` because request definitions are meant to be
   * created once and reused — they describe an endpoint, not a single call.
   * Per-call customization (extra headers, abort signals, etc.) is handled
   * via `CallOptions` at invocation time, not by mutating this config.
   *
   * @see {@link RequestConfig} for the full shape of the config object.
   */
  readonly config: RequestConfig

  /**
   * Creates a new Request instance with the given endpoint configuration.
   *
   * The constructor simply stores the config — no validation or side effects.
   * The config is used later by `createApi` when the endpoint is actually called.
   *
   * @param config - The endpoint configuration describing the HTTP method,
   *   path template, middleware, headers, and serialization behavior.
   *
   * @example
   * ```ts
   * const listItems = new Request<{ page: number; limit: number }, Item[]>({
   *   method: 'GET',
   *   path: '/items',
   *   dedupe: true, // auto-cancel previous in-flight request
   * })
   * ```
   */
  constructor(config: RequestConfig) {
    // Store the config as-is. No defensive copy is made because RequestConfig
    // contains only simple values and optional arrays — and the contract is
    // that callers define these once and don't mutate them afterward.
    this.config = config
  }

  /**
   * Determines whether this request's params should be serialized as a URL
   * query string (as opposed to a JSON request body).
   *
   * The logic follows standard REST conventions with an escape hatch:
   *
   * 1. If `bodyAs` is explicitly set on the config, that takes precedence:
   *    - `bodyAs: 'query'` → always serialize as query string (even for POST)
   *    - `bodyAs: 'body'`  → always serialize as request body (even for GET/DELETE)
   *
   * 2. If `bodyAs` is not set, fall back to the HTTP method convention:
   *    - `GET` / `DELETE` → params go to query string (returns `true`)
   *    - `POST` / `PUT` / `PATCH` → params go to request body (returns `false`)
   *
   * This getter is used by the fetch layer in `createApi` to decide how to
   * pass the caller's params to the `buildUrl` utility and whether to set
   * a `body` on the fetch `RequestInit`.
   *
   * @returns `true` if params should be appended to the URL as a query string,
   *   `false` if params should be sent as a JSON request body.
   *
   * @example
   * ```ts
   * const get = new Request<{ page: number }, unknown>({ method: 'GET', path: '/items' })
   * get.shouldSerializeAsQuery // → true (GET defaults to query)
   *
   * const post = new Request<{ name: string }, unknown>({ method: 'POST', path: '/items' })
   * post.shouldSerializeAsQuery // → false (POST defaults to body)
   *
   * const deleteWithBody = new Request<{ ids: string[] }, unknown>({
   *   method: 'DELETE',
   *   path: '/items',
   *   bodyAs: 'body',
   * })
   * deleteWithBody.shouldSerializeAsQuery // → false (bodyAs overrides DELETE default)
   * ```
   */
  get shouldSerializeAsQuery(): boolean {
    // If the user explicitly specified how to serialize params, respect that.
    // This is the "escape hatch" that lets you do things like "POST with query
    // params" or "DELETE with a JSON body" — cases that deviate from REST norms.
    if (this.config.bodyAs) {
      return this.config.bodyAs === 'query'
    }

    // No explicit override — fall back to the standard convention based on
    // the HTTP method. GET and DELETE serialize to query; everything else
    // (POST, PUT, PATCH) serializes to body.
    return QUERY_METHODS.has(this.config.method)
  }
}
