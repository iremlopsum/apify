// =============================================================================
// types.ts — Foundational type definitions for the apify library
// =============================================================================
//
// This file contains every shared type used across the library. It is the
// single source of truth for the shapes of configs, results, middleware, and
// the API constructor options.
//
// Why a single types file?
// Having one central place prevents circular import issues (especially between
// result.ts and middleware.ts which both need to reference each other's types).
// The ApiError class lives in result.ts but is re-exported here so every module
// can import it from one place.
// =============================================================================

// ---------------------------------------------------------------------------
// Forward reference for ApiError
// ---------------------------------------------------------------------------
// ApiError is a *class* (not just a type) defined in result.ts. We re-export
// it as a type here so that interfaces like Result<T> and ApiConfig can
// reference it without creating a circular dependency at runtime.
// At runtime, modules that need the actual class import directly from result.ts.
// ---------------------------------------------------------------------------
import type { ApiError } from './result.js'
export type { ApiError }

// ---------------------------------------------------------------------------
// HTTP Method
// ---------------------------------------------------------------------------

/**
 * HTTP methods supported by the library.
 *
 * These are the standard REST methods. Each method has default serialization
 * behavior in the library:
 * - `GET` / `DELETE` → params are serialized as query string (+ path params)
 * - `POST` / `PUT` / `PATCH` → params are serialized as request body
 *
 * This default can be overridden per-request with the `bodyAs` option in
 * {@link RequestConfig}.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// ---------------------------------------------------------------------------
// Response Type
// ---------------------------------------------------------------------------

/**
 * Determines how the library parses the HTTP response body.
 *
 * - `'json'` (default) — calls `response.json()`, returns parsed object
 * - `'text'` — calls `response.text()`, returns raw string
 * - `'blob'` — calls `response.blob()`, returns a Blob (useful for file downloads)
 * - `'arrayBuffer'` — calls `response.arrayBuffer()`, returns raw binary data
 * - `'formData'` — calls `response.formData()`, returns FormData (rare)
 *
 * Set this on the {@link RequestConfig} for a specific endpoint. If omitted,
 * the library defaults to `'json'`.
 */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData'

// ---------------------------------------------------------------------------
// Request Config
// ---------------------------------------------------------------------------

/**
 * Configuration object passed to the `Request` class constructor.
 *
 * Each API endpoint is defined as a `new Request<TParams, TResponse>(config)`.
 * This interface describes the shape of that config.
 *
 * @example
 * ```ts
 * const getUser = new Request<{ id: string }, User>({
 *   method: 'GET',
 *   path: '/users/:id',           // :id is substituted from params
 *   middleware: [cacheMiddleware], // runs only for this endpoint
 *   responseType: 'json',         // default, could be omitted
 * })
 * ```
 */
export interface RequestConfig {
  /** The HTTP method to use for this endpoint. */
  method: HttpMethod

  /**
   * URL path template, relative to the `baseUrl` set in `createApi`.
   *
   * Supports `:param` syntax for path parameters. When the request is made,
   * matching keys from the params object are substituted into the path and
   * excluded from the query string or body.
   *
   * @example '/users/:id'      → params { id: '42' }  → '/users/42'
   * @example '/orgs/:org/repos' → params { org: 'acme' } → '/orgs/acme/repos'
   */
  path: string

  /**
   * Middleware that runs only for this specific endpoint.
   *
   * Execution order: global middleware → per-request middleware → per-call middleware.
   * Each layer wraps the next in an "onion" pattern.
   */
  middleware?: Middleware[]

  /**
   * Default headers sent with every call to this endpoint.
   *
   * Merge precedence (most specific wins):
   * 1. Global headers (from `createApi` config) — lowest priority
   * 2. Per-request headers (this field) — overrides global
   * 3. Per-call headers (from `CallOptions`) — highest priority
   */
  headers?: HeadersInit

  /**
   * How to parse the response body. Defaults to `'json'`.
   * @see {@link ResponseType} for available options.
   */
  responseType?: ResponseType

  /**
   * When `true`, enables auto-cancellation of duplicate in-flight requests.
   *
   * If a new call to this endpoint starts while a previous one is still
   * pending, the previous request is automatically aborted. Useful for
   * search-as-you-type or rapidly changing date filters.
   *
   * Identity is per `Request` instance — each Request object tracks at most
   * one in-flight call.
   *
   * @default false (dedupe is opt-in)
   */
  dedupe?: boolean

  /**
   * Override the default body serialization strategy.
   *
   * By default, GET/DELETE serialize params as query strings, and
   * POST/PUT/PATCH serialize params as request body (JSON). Use this to
   * override that behavior:
   *
   * - `'query'` — force params to query string (e.g., POST with query params)
   * - `'body'` — force params to request body (e.g., DELETE with JSON body)
   *
   * @example
   * ```ts
   * // DELETE endpoint that expects a JSON body with IDs to delete
   * const bulkDelete = new Request<{ ids: string[] }, { deleted: number }>({
   *   method: 'DELETE',
   *   path: '/items',
   *   bodyAs: 'body',
   * })
   * ```
   */
  bodyAs?: 'query' | 'body'
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The result object returned by every API call. This is the core of the
 * library's error handling strategy — instead of throwing exceptions, every
 * call returns a discriminated result that the caller can inspect.
 *
 * On success: `data` is the typed response, `error` is null.
 * On failure: `data` is null, `error` is an {@link ApiError} with details.
 *
 * The `response` field gives access to the raw `Response` object (headers,
 * status, etc.). It is `null` for network errors where no HTTP response exists
 * (DNS failure, CORS block, abort, etc.).
 *
 * The `retry` function re-executes the exact same request through the full
 * middleware chain (so auth tokens are re-injected, logging fires again, etc.).
 *
 * @typeParam TResponse - The shape of the successful response data.
 *
 * @example
 * ```ts
 * const { data, error, retry } = await api.getUser({ id: '42' })
 *
 * if (error) {
 *   if (error.status === 401) redirectToLogin()
 *   else console.error(error.body)
 *   return
 * }
 *
 * // data is typed as User here
 * console.log(data.name)
 * ```
 */
export interface Result<TResponse> {
  /** The parsed response data on success, or `null` on error. */
  data: TResponse | null

  /** Structured error details on failure, or `null` on success. */
  error: ApiError | null

  /**
   * The raw fetch `Response` object. Useful for reading headers, status
   * codes, or other metadata. `null` when no HTTP response exists (network
   * errors, aborted requests).
   */
  response: Response | null

  /**
   * Re-execute this exact request through the full middleware chain.
   *
   * Always re-enters from the outermost middleware, so auth injection,
   * logging, etc. all fire again. Useful for retry-after-refresh patterns.
   */
  retry: () => Promise<Result<TResponse>>
}

// ---------------------------------------------------------------------------
// Call Options
// ---------------------------------------------------------------------------

/**
 * Per-call options available as the optional second argument to any API method.
 *
 * These allow overriding middleware, headers, and cancellation on a
 * call-by-call basis without changing the endpoint definition.
 *
 * @example
 * ```ts
 * // Add extra middleware and an abort signal for this one call
 * const { data } = await api.getItems({ page: 1 }, {
 *   middleware: [customLogMiddleware],
 *   skipMiddleware: [cacheMiddleware],
 *   headers: { 'X-Request-Id': crypto.randomUUID() },
 *   signal: abortController.signal,
 * })
 * ```
 */
export interface CallOptions {
  /**
   * Additional middleware to append for this call only.
   * Runs after global and per-request middleware.
   */
  middleware?: Middleware[]

  /**
   * Middleware to skip for this call, compared by reference identity.
   *
   * ⚠️  Factory-style middleware (like `retryMiddleware(3)`) must be stored
   * in a variable first — passing a new factory call here will create a
   * new reference that won't match the original.
   */
  skipMiddleware?: Middleware[]

  /** Extra headers for this call. Highest merge priority (overrides all). */
  headers?: HeadersInit

  /**
   * An `AbortSignal` to cancel this request. When the signal fires,
   * the fetch is aborted and the result contains an error with `status: 0`.
   */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Middleware Types
// ---------------------------------------------------------------------------

/**
 * Context object passed to each middleware function in the chain.
 *
 * Contains all the information about the current request: the HTTP method,
 * the fully-resolved URL, the original path template, the caller's params,
 * the merged headers, and the serialized body.
 *
 * Middleware can read and modify `ctx.request.headers` and `ctx.request.body`
 * before calling `next()` — changes will propagate to the actual fetch call.
 *
 * **Typing note:** The spec defines MiddlewareContext with generic TParams and
 * TResponse, but middleware is intentionally loosely typed. Authors work with
 * `unknown` and cast internally if they need specific types. This avoids
 * complex generic inference issues and keeps middleware composable.
 */
export interface MiddlewareContext {
  /** Mutable request details — middleware can modify headers and body. */
  request: {
    /** HTTP method (GET, POST, etc.) */
    method: string
    /** Fully resolved URL with path params substituted and query string appended. */
    url: string
    /** Original path template (e.g., '/users/:id') — useful for logging. */
    path: string
    /** The original params object passed by the caller. */
    params: unknown
    /** Merged headers — middleware can add/remove headers here. */
    headers: Headers
    /** Serialized request body, or null for GET/DELETE requests. */
    body: unknown | null
  }

  /** The key name of the request in the api object (e.g., 'getUser'). */
  requestName: string
}

/**
 * The "next" function passed to middleware. Calling it invokes the next
 * middleware in the chain, or the actual fetch if this is the innermost layer.
 *
 * @typeParam TResponse - The expected response type (always `unknown` in practice).
 */
export type MiddlewareNext<TResponse> = () => Promise<Result<TResponse>>

/**
 * Middleware function signature.
 *
 * Middleware follows the "onion" model (like Koa or Redux middleware):
 * each middleware wraps the next, can modify the request going in and
 * the result coming out.
 *
 * - Call `next()` to proceed to the next layer.
 * - Return early (without calling `next()`) to short-circuit (e.g., cache hit).
 * - Call `next()` multiple times for retry behavior.
 *
 * @example
 * ```ts
 * // Auth middleware — injects a Bearer token into every request
 * const authMiddleware: Middleware = async (ctx, next) => {
 *   ctx.request.headers.set('Authorization', `Bearer ${getToken()}`)
 *   return next()
 * }
 * ```
 *
 * @example
 * ```ts
 * // Short-circuit middleware — returns cached data without hitting the server
 * const cacheMiddleware: Middleware = async (ctx, next) => {
 *   const cached = cache.get(ctx.request.url)
 *   if (cached) return cached
 *   return next()
 * }
 * ```
 */
export type Middleware = (context: MiddlewareContext, next: MiddlewareNext<unknown>) => Promise<Result<unknown>>

// ---------------------------------------------------------------------------
// API Config
// ---------------------------------------------------------------------------

/**
 * Configuration for the `createApi` constructor.
 *
 * This is the top-level config that wires together all request definitions,
 * global middleware, default headers, and error handling into a typed API client.
 *
 * @typeParam TRequests - The record of request definitions (inferred from usage).
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: '/api',
 *   requests: { getUser, listUsers, createUser },
 *   middleware: [authMiddleware, logMiddleware],
 *   headers: { 'X-App-Version': '2.0.0' },
 *   onError: (error) => Sentry.captureException(error),
 * })
 * ```
 */
export interface ApiConfig<TRequests extends Record<string, unknown>> {
  /**
   * Base URL prepended to every request path.
   *
   * @example '/api'           → paths become '/api/users', '/api/items', etc.
   * @example 'https://api.example.com' → for absolute URLs
   * @example ''               → same-origin requests (path used as-is)
   */
  baseUrl: string

  /**
   * Record of Request instances. Each key becomes a method on the API object.
   *
   * @example { getUser, listUsers, createUser } → api.getUser(), api.listUsers(), etc.
   */
  requests: TRequests

  /**
   * Global middleware applied to every request.
   * Runs first in the middleware chain (before per-request and per-call middleware).
   */
  middleware?: Middleware[]

  /**
   * Default headers sent with every request.
   * Lowest merge priority — overridden by per-request and per-call headers.
   */
  headers?: HeadersInit

  /**
   * Global error callback. Fires after the full middleware chain completes,
   * just before the result is returned to the caller.
   *
   * Only fires when the **final** result has an error. If a retry middleware
   * recovers a 5xx to a 200, this does NOT fire.
   *
   * Fires for both HTTP errors (4xx, 5xx) and network errors (status 0).
   *
   * @example
   * ```ts
   * onError: (error) => {
   *   if (error.status === 401) redirectToLogin()
   *   Sentry.captureException(error)
   * }
   * ```
   */
  onError?: (error: ApiError) => void
}

// ---------------------------------------------------------------------------
// GraphQL Types
// ---------------------------------------------------------------------------

/**
 * Configuration object for the `Operation` class constructor.
 *
 * The `operation` field holds the GraphQL document string. It is sent to the
 * server under the key `"query"` (per the GraphQL over HTTP spec), but is
 * named `operation` here to make clear it can be a query or mutation.
 */
export interface OperationConfig {
  /** The GraphQL document string. Sent as `{ query: ... }` on the wire. */
  operation: string

  /**
   * Middleware that runs only for this specific operation.
   *
   * Execution order: global middleware → per-operation middleware → per-call middleware.
   * Each layer wraps the next in an "onion" pattern.
   */
  middleware?: Middleware[]

  /**
   * Default headers for this operation.
   *
   * Merge precedence (most specific wins):
   * 1. Global headers (from `createGraphQL` config) — lowest priority
   * 2. Per-operation headers (this field)
   * 3. Per-call headers (from `CallOptions`) — highest priority
   */
  headers?: HeadersInit

  /**
   * When `true`, enables auto-cancellation of duplicate in-flight requests.
   *
   * If a new call to this operation starts while a previous one is still
   * pending, the previous request is automatically aborted.
   *
   * @default false
   */
  dedupe?: boolean
}

/**
 * A single GraphQL error as returned by the server in `{ errors: [...] }`.
 * Mirrors the GraphQL spec error shape.
 */
export interface GraphQLError {
  /** Human-readable description of the error. */
  message: string
  /** Character positions in the GraphQL document where the error originated. */
  locations?: Array<{ line: number; column: number }>
  /** Path to the response field that produced the error, for partial responses. */
  path?: Array<string | number>
  /** Server-defined additional metadata about the error. */
  extensions?: Record<string, unknown>
}

/**
 * Base configuration shared by both `createGraphQL` overloads.
 */
export interface GraphQLBaseConfig {
  /** The full URL of the GraphQL endpoint, e.g. `'https://api.example.com/graphql'`. */
  endpoint: string

  /**
   * Global middleware applied to every operation.
   * Runs first in the middleware chain (before per-operation and per-call middleware).
   */
  middleware?: Middleware[]

  /**
   * Default headers sent with every operation.
   * Lowest merge priority — overridden by per-operation and per-call headers.
   */
  headers?: HeadersInit

  /**
   * Global error callback. Fires after the full middleware chain completes.
   *
   * Fires for GraphQL errors (HTTP 200 with `{ errors }`), HTTP errors (4xx/5xx),
   * and network errors (status 0). Does NOT fire when the result is successful.
   */
  onError?: (error: ApiError) => void
}
