// =============================================================================
// create-api.ts — The core API client constructor for the apify library
// =============================================================================
//
// This is the heart of the library. It takes a set of Request definitions and
// wires them together with middleware, headers, and the native fetch API into a
// typed API object where each key becomes a callable method.
//
// The flow for each API call:
//
//   1. Caller invokes api.getUser({ id: '42' }, { signal, headers, ... })
//   2. createApi's generated method:
//      a. Builds the URL (path param substitution + optional query string)
//      b. Merges headers (global < per-request < per-call)
//      c. Serializes the body (JSON, FormData, etc.)
//      d. Computes the effective abort signal (with dedupe if enabled)
//      e. Composes middleware (global + per-request + per-call, minus skipped)
//      f. Executes the composed chain → core fetch → returns Result
//      g. Fires onError if the final result has an error
//
// The generated methods are fully typed — TypeScript infers the params and
// response types from the Request<TParams, TResponse> generics. When TParams
// is Record<string, never>, the params argument becomes optional.
//
// Design decisions:
// - retry() re-enters execute(), which rebuilds the full middleware chain.
//   This ensures auth tokens, logging, etc. all fire again on retry.
// - The entire execute() body is wrapped in try/catch to handle synchronous
//   errors (e.g., TypeError from buildUrl for nested objects in query strings).
//   These are returned as Result errors, not unhandled rejections.
// - onError fires AFTER the middleware chain, so retry middleware can recover
//   errors without triggering the global error handler.
// - Dedupe integration is handled transparently — when a Request has
//   dedupe: true, the signal is routed through a DedupeTracker that
//   auto-cancels previous in-flight requests for the same endpoint.
// =============================================================================

import { Request } from './request.js'
import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from './result.js'
import { composeMiddleware } from './middleware.js'
import { buildUrl, joinUrl } from './utils/path-params.js'
import { serializeBody } from './utils/serialize.js'
import { DedupeTracker } from './utils/dedupe.js'
import { ShareTracker, isAbandoned } from './utils/share.js'
import { mergeHeaders } from './utils/headers.js'
import { abortKind, propagatesReason } from './utils/abort-kind.js'
import { anySignal } from './utils/any-signal.js'
import { operationBudget, perCallerBudget } from './utils/budget.js'
import { stableStringify } from './utils/cache.js'
import { isSpecialBody, isOpaqueParams } from './utils/special-body.js'
import type { ApiConfig, CallOptions, ErrorResult, Middleware, MiddlewareContext, Result, ResponseType } from './types.js'

// =============================================================================
// Type helpers — these bridge Request generics to the API method signatures
// =============================================================================

/**
 * Extracts the TParams type from a Request instance.
 *
 * Given `Request<{ id: string }, User>`, this resolves to `{ id: string }`.
 * Used internally by the Api mapped type to infer method parameter types.
 *
 * @typeParam R - A Request instance (or anything — returns `never` for non-Request types).
 */
type ExtractParams<R> = R extends Request<infer P, any> ? P : never

/**
 * Extracts the TResponse type from a Request instance.
 *
 * Given `Request<{ id: string }, User>`, this resolves to `User`.
 * Used internally by the Api mapped type to infer method return types.
 *
 * @typeParam R - A Request instance (or anything — returns `never` for non-Request types).
 */
type ExtractResponse<R> = R extends Request<any, infer Res> ? Res : never

/**
 * Defines the signature of a generated API method.
 *
 * The key trick here is the conditional type: when TParams is
 * `Record<string, never>` (an empty object — meaning the endpoint takes no
 * params), the `params` argument becomes optional. This allows callers to
 * write `api.health()` instead of `api.health({})`.
 *
 * The condition `Record<string, never> extends TParams` works because:
 * - When TParams IS Record<string, never>, the condition is true → optional params
 * - When TParams has required keys (e.g., { id: string }), Record<string, never>
 *   does NOT extend it → required params
 *
 * @typeParam TParams - The params type for this endpoint.
 * @typeParam TResponse - The response type for this endpoint.
 */
type ApiMethod<TParams extends object, TResponse> =
  Record<string, never> extends TParams
    ? (params?: TParams, options?: CallOptions) => Promise<Result<TResponse>>
    : (params: TParams, options?: CallOptions) => Promise<Result<TResponse>>

/**
 * The typed API object returned by createApi.
 *
 * This is a mapped type that transforms a record of Request instances into
 * a record of callable methods. Each key from the `requests` config becomes
 * a method with fully typed params and response.
 *
 * @example
 * ```ts
 * // Given:
 * const requests = {
 *   getUser: new Request<{ id: string }, User>({ ... }),
 *   listUsers: new Request<Record<string, never>, User[]>({ ... }),
 * }
 *
 * // Api<typeof requests> resolves to:
 * {
 *   getUser: (params: { id: string }, options?: CallOptions) => Promise<Result<User>>
 *   listUsers: (params?: Record<string, never>, options?: CallOptions) => Promise<Result<User[]>>
 * }
 * ```
 *
 * @typeParam TRequests - The record of Request instances from the config.
 */
type Api<TRequests extends Record<string, Request<any, any>>> = {
  [K in keyof TRequests]: ApiMethod<ExtractParams<TRequests[K]>, ExtractResponse<TRequests[K]>>
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Parses the response body according to the configured response type.
 *
 * Each Request can specify how its response should be parsed (json, text, blob,
 * etc.). This function dispatches to the appropriate Response method.
 *
 * Special handling for JSON: we first read the body as text and then parse it.
 * This avoids the "unexpected end of input" error that response.json() throws
 * on empty responses (e.g., 204 No Content, or a 200 with an empty body).
 * Empty text is returned as null instead of throwing.
 *
 * @param response - The raw fetch Response object to parse.
 * @param responseType - How to parse the body. Defaults to 'json'.
 * @returns The parsed response body (type depends on responseType).
 */
async function parseResponse(response: Response, responseType: ResponseType = 'json'): Promise<unknown> {
  switch (responseType) {
    case 'text':
      return response.text()
    case 'blob':
      return response.blob()
    case 'arrayBuffer':
      return response.arrayBuffer()
    case 'formData':
      return response.formData()
    case 'none':
      // The caller has declared this endpoint returns no body, so there is
      // nothing to parse and a body the server sends anyway is discarded.
      //
      // Cancel the stream rather than leaving it unread: an abandoned body
      // can hold a keep-alive connection open. Guarded because cancelling an
      // absent or already-consumed stream can throw, and cleanup must never
      // fail a request that otherwise succeeded.
      try {
        await response.body?.cancel()
      } catch {
        /* nothing to release */
      }
      return undefined
    case 'json':
    default: {
      // Read as text first to safely handle empty responses.
      // response.json() throws on empty bodies, but sometimes servers return
      // 200 OK with no body (especially for DELETE or fire-and-forget endpoints).
      const text = await response.text()
      return text ? JSON.parse(text) : null
    }
  }
}

/**
 * Builds a `Result` for a failure that never reached (or never came back
 * from) `core()`, so there is no `Response` to report and no HTTP status.
 *
 * Three situations produce one:
 *
 * - a sharer giving up before the shared request settles (`'abort'`) — the
 *   shared request itself is unaffected unless this was the last reference,
 *   which is the refcount's job, not this function's;
 * - a synchronous error during request setup (`'network'`), most often the
 *   `TypeError` `buildUrl` throws for a nested query-string object;
 * - a rejection escaping the middleware chain (`'middleware'`, or `'network'`
 *   for a setup failure).
 *
 * Classification is by **provenance**, not by sniffing `reason`'s shape: a
 * failure only counts as *our* cancellation when `signal` — the AbortSignal
 * that actually governs this operation — is the one that aborted. That is
 * what lets a caller's custom abort reason (`ac.abort(new Error('x'))`, or a
 * plain string) still classify as `'abort'`/`'timeout'` instead of falling
 * through to `'network'` — `abortKind` only recognises the standard
 * `AbortError`/`TimeoutError` names, but the signal itself always knows why
 * it aborted regardless of what shape its `reason` takes.
 *
 * For a `'middleware'` fallback this additionally requires `reason` to
 * *propagate* `signal.reason` (see `propagatesReason` — exact identity, or
 * one level of `.cause`). A middleware can throw its own `AbortError`-named
 * failure that has nothing to do with this request's own signal — a
 * rethrown IndexedDB quota abort, say — and that must stay `'middleware'`,
 * not be swallowed as `'abort'` just because the name matches. Propagation
 * is a heuristic for that, not proof — `propagatesReason`'s doc names the
 * known false positive (a middleware's own error using `{ cause }` to
 * explain *why* it failed, not to claim it *is* the cancellation) — but it's
 * the closest approximation available, and rejecting it in favour of exact
 * identity alone is measurably worse (see the same doc). A non-`'middleware'`
 * fallback doesn't need that check: a fetch rejection while our own signal
 * is aborted IS that cancellation, whatever shape fetch happened to throw.
 *
 * Deferred item: `error.request.url` here is `joinUrl(baseUrl, request.config.path)`
 * — the un-substituted path template (e.g. `/users/:id`), not the URL that was
 * (or would have been) actually requested. That differs from the `'http'` and
 * `'parse'` paths in `execute()`, which build `error.request.url` from
 * `ctx.request.url` — the real, path-substituted URL `buildUrl` produced.
 * Callers branching on `error.request.url` for a `'middleware'` result or a
 * setup error get the template, not the resolved address. Not fixed here;
 * recorded so a reader hitting it isn't left to rediscover it.
 */
function syntheticResult(
  reason: unknown,
  signal: AbortSignal | undefined,
  fallbackKind: 'abort' | 'network' | 'middleware',
  method: string,
  url: string,
  params: unknown,
  retry: () => Promise<Result<unknown>>
): ErrorResult<unknown> {
  const isOurCancellation =
    signal?.aborted === true &&
    (fallbackKind !== 'middleware' || propagatesReason(reason, signal.reason))
  const kind = isOurCancellation ? (abortKind(signal!.reason) ?? 'abort') : fallbackKind
  const error = new ApiError({
    kind,
    status: 0,
    statusText: '',
    body: reason,
    headers: new Headers(),
    request: { method, url, params }
  })
  return createNetworkErrorResult(error, retry)
}

/**
 * True when a `HeadersInit` carries no entries at all.
 *
 * The `share` gate needs *emptiness*, not truthiness: `headers: {}` and
 * `middleware: []` are both truthy, so a plain `!options.headers` test would
 * silently disable coalescing for a caller that passed an empty object —
 * exactly the shape a `...spread` of an optional config produces.
 */
function isEmptyHeaders(init: HeadersInit | undefined): boolean {
  if (init === undefined) return true
  if (init instanceof Headers) {
    let empty = true
    init.forEach(() => { empty = false })
    return empty
  }
  if (Array.isArray(init)) return init.length === 0
  return Object.keys(init).length === 0
}

// =============================================================================
// createApi — the main export
// =============================================================================

/**
 * Creates a typed API client from a set of Request definitions.
 *
 * This is the primary entry point of the apify library. It takes a configuration
 * object containing a base URL, request definitions, optional global middleware,
 * default headers, and an error callback, and returns an object where each request
 * key becomes a callable, fully-typed method.
 *
 * **How it works internally:**
 *
 * For each Request in the `requests` record, createApi generates a method that:
 * 1. Builds the URL from baseUrl + path template + params (path param substitution)
 * 2. Merges headers from three layers (global < per-request < per-call)
 * 3. Serializes the body (JSON for plain objects, passthrough for FormData/Blob/etc.)
 * 4. Computes the effective abort signal (includes dedupe tracking if enabled)
 * 5. Composes the middleware chain (global → per-request → per-call, minus skipped)
 * 6. Executes the chain, with the core fetch as the innermost layer
 * 7. Fires the onError callback if the final result has an error
 *
 * **Dedupe integration:**
 *
 * A single DedupeTracker instance is created per createApi call. When a Request
 * has `dedupe: true`, the abort signal is routed through the tracker before being
 * passed to fetch. This means that firing a new request for the same endpoint
 * automatically cancels any previous in-flight request — perfect for
 * search-as-you-type, paginated lists, or rapidly changing filters.
 *
 * **Error handling philosophy:**
 *
 * The library never throws — every outcome is expressed as a Result<T>.
 * - HTTP errors (4xx, 5xx) → Result with error, response, and retry
 * - Network errors → Result with error (status 0), null response, and retry
 * - Synchronous errors (e.g., TypeError from query string serialization) → same
 *
 * @typeParam TRequests - Record of Request instances. Keys become method names,
 *   and the Request's TParams/TResponse generics become the method's signature.
 *
 * @param config - API configuration with baseUrl, requests, middleware, headers, onError.
 * @returns A typed object where each request key is a callable method.
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
 *
 * // Fully typed: params and response inferred from Request generics
 * const { data, error, retry } = await api.getUser({ id: '42' })
 * ```
 */
export function createApi<TRequests extends Record<string, Request<any, any>>>(
  config: ApiConfig<TRequests>
): Api<TRequests> {
  // Destructure the config for convenience. Default globalMiddleware to an
  // empty array so we don't need null checks throughout the function.
  const { baseUrl, requests, middleware: globalMiddleware = [], headers: globalHeaders, onError } = config

  /**
   * Calls the consumer's `onError`, swallowing anything it throws.
   *
   * `onError` is a user callback on the one path that must never fail: it
   * runs *after* the result is in hand, so an exception from it would reject
   * a promise that already has a perfectly good `Result` to hand back — the
   * caller would see a throw for a request that merely returned a 500. A
   * Sentry client in a misconfigured environment, or a logger dereferencing
   * `error.response.status`, is all it takes. Same stance as `retryOn`,
   * `onRetry` and the custom `delay` curve in `built-in-middleware.ts`.
   */
  const fireOnError = (error: ApiError): void => {
    // Aborts are cancellations we caused — a caller's own signal, or a newer
    // request superseding this one under dedupe. Reporting them to an error
    // tracker is noise. Timeouts are deliberately NOT suppressed: a deadline
    // you missed is a genuine failure, which is why the two kinds are separate.
    if (error.kind === 'abort') return
    if (!onError) return
    try {
      onError(error)
    } catch {
      /* swallowed by contract — onError cannot fail a request */
    }
  }

  // ---------------------------------------------------------------------------
  // Dedupe tracker — shared across all endpoints in this API instance.
  //
  // Each endpoint that has dedupe: true will use this tracker to auto-cancel
  // previous in-flight requests. The tracker is per-createApi (not global)
  // because different API instances should have independent dedupe state.
  // ---------------------------------------------------------------------------
  const dedupeTracker = new DedupeTracker()

  // ---------------------------------------------------------------------------
  // Share tracker — shared across all endpoints in this API instance, same
  // per-createApi lifetime rationale as dedupeTracker above.
  //
  // share and dedupe are opposites (share joins the existing call, dedupe
  // cancels it), so a Request that sets both is a contradiction with no
  // sensible combined semantics. Validate this up front, at construction
  // time, rather than at call time: it's the one sanctioned throw outside a
  // Result, because it's a configuration mistake, not a request failure.
  // ---------------------------------------------------------------------------
  const shareTracker = new ShareTracker()

  for (const [name, request] of Object.entries(requests)) {
    if (request.config.share && request.config.dedupe) {
      throw new Error(
        `Request "${name}" sets both share and dedupe. They are opposites — ` +
        `dedupe cancels the previous call, share joins it. Pick one.`
      )
    }
  }

  // The api object is built up imperatively by iterating over the requests
  // record. Each key becomes a method on the api object.
  // We use `Record<string, Function>` internally because the precise types
  // are enforced by the return type cast `as Api<TRequests>` at the end.
  const api = {} as Record<string, Function>

  for (const [name, request] of Object.entries(requests)) {
    // =========================================================================
    // Generate the API method for this request definition
    // =========================================================================
    // Each iteration creates a closure that captures `name` and `request`.
    // The generated method accepts optional params and call options.
    // =========================================================================
    api[name] = (params: object = {}, options: CallOptions = {}): Promise<Result<unknown>> => {
      /**
       * A `Result` for a failure with no `Response` behind it — construction
       * only, no reporting. A function declaration rather than a const so it
       * can name `execute` (as the Result's `retry`) before that binding
       * exists further down.
       *
       * Split out of `failedResult` (below) because the share path's `onAbort`
       * builds a Result and reports it in two visibly separate steps. That
       * split is now presentational rather than conditional — since the
       * tracker marks abandonment explicitly, `onAbort` reports every time —
       * but keeping construction free of the side effect is what let the
       * reporting decision move out of this function in the first place.
       */
      function buildFailedResult(
        reason: unknown,
        signal: AbortSignal | undefined,
        fallbackKind: 'abort' | 'network' | 'middleware'
      ): ErrorResult<unknown> {
        return syntheticResult(
          reason,
          signal,
          fallbackKind,
          request.config.method,
          joinUrl(baseUrl, request.config.path),
          params,
          execute
        )
      }

      /**
       * `buildFailedResult` plus reporting to `onError` — the common case,
       * used everywhere a failure has no other path to the error tracker.
       */
      function failedResult(
        reason: unknown,
        signal: AbortSignal | undefined,
        fallbackKind: 'abort' | 'network' | 'middleware'
      ): ErrorResult<unknown> {
        const result = buildFailedResult(reason, signal, fallbackKind)
        fireOnError(result.error as ApiError)
        return result
      }

      /**
       * The execute function encapsulates the entire request lifecycle.
       *
       * It is defined as a named function (not an arrow) so that it can be
       * passed as the `retry` callback in Result objects. When the caller
       * calls `result.retry()`, it re-enters execute() from scratch —
       * rebuilding the URL, re-merging headers, re-composing middleware,
       * and re-executing the fetch. This ensures that retry always goes
       * through the full pipeline (auth re-injection, logging, etc.).
       *
       * The entire body is wrapped in try/catch to capture synchronous
       * errors (e.g., TypeError from buildUrl when a nested object is
       * passed as a query string param). These are returned as Result
       * errors rather than unhandled rejections, keeping the "never throws"
       * contract intact.
       *
       * `sharedSignal`, when given, is merged with the operation's own
       * deadline to form the signal that actually drives the fetch, displacing
       * this caller's personal `options.signal` / timeout from it. It is never
       * an override — hence the name. This is used only by the `share: true`
       * path below: the first caller to acquire a shared slot hands `execute`
       * the ShareTracker's own refcounted signal, so the real network request
       * is governed by "has every sharer given up?" rather than by any single
       * caller's personal signal or timeout.
       * `result.retry()` calls `execute` with no argument, so a retry (shared
       * or not) always falls back to this caller's own `options.signal` /
       * timeout — a retry is a fresh, unshared request.
       *
       * `onSettled`, when given, is invoked the instant this operation has a
       * `Result` and BEFORE that Result is reported to `onError`. The share
       * site uses it to tell a genuine give-up from a vestigial one; see the
       * post-execution hook.
       */
      const execute = (sharedSignal?: AbortSignal, onSettled?: () => void): Promise<Result<unknown>> => {
        try {
          // -----------------------------------------------------------------
          // Step 1: Compose the middleware chain
          // -----------------------------------------------------------------
          // Middleware runs in this order: global → per-request → per-call.
          // This matches the "most general to most specific" convention.
          // Global middleware (auth, logging) wraps everything. Per-request
          // middleware (validation, caching) wraps the specific endpoint.
          // Per-call middleware (one-off customizations) is innermost.
          // -----------------------------------------------------------------
          const allMiddleware: Middleware[] = [
            ...globalMiddleware,
            ...(request.config.middleware ?? []),
            ...(options.middleware ?? [])
          ]

          // -----------------------------------------------------------------
          // Step 2: Compute the effective abort signal
          // -----------------------------------------------------------------
          // The caller's signal is the starting point, and it is what the
          // context carries into the middleware chain. When dedupe is enabled
          // the real registration happens inside core() — see below — so that
          // a middleware which short-circuits (a cache hit) never cancels a
          // live request that is genuinely in flight, and so that a signal
          // installed by middleware is an input to dedupe rather than
          // something dedupe overwrites.
          //
          // dedupeController doubles as the "already registered" flag: it is
          // set on the first attempt that reaches core() and survives across
          // retries, which keeps registration once per execute().
          // -----------------------------------------------------------------
          // Resolve the deadline: per-call beats per-request, and non-positive
          // means none. The signal is created once here — not inside core() —
          // so a retry sequence draws from a single budget rather than getting
          // a fresh one per attempt.
          //
          // Under `share` (sharedSignal supplied) only the *per-request*
          // deadline applies here, merged with the refcount signal rather than
          // replacing it. `RequestConfig.timeout` is a property of the
          // operation — "this endpoint must answer within 5s" — so it belongs
          // to the one real request every sharer is waiting on, and is measured
          // from when that request started. Suppressing it here instead, and
          // applying it per-caller at the share site, is what let a steady
          // arrival of joiners hold one socket open indefinitely: each new
          // joiner's clock started at *its* join time, and the request itself
          // had no deadline at all.
          //
          // `CallOptions.timeout` is deliberately absent from this branch: a
          // single caller's patience must not shorten (or lengthen) the shared
          // operation for everyone else, so it is observed per-caller at the
          // share site instead.
          //
          // Both deadlines come from one `resolveBudget`, which is the single
          // place that knows the operation/per-caller split. It is resolved
          // here, once per execute(), rather than once per api-method call:
          // `result.retry()` re-enters execute() and must draw a FRESH
          // deadline, not the exhausted remains of the first attempt's
          // (tests/timeout.test.ts, "gives retry() a fresh budget"). Within a
          // single execute() it is still resolved exactly once, so a
          // retryMiddleware sequence draws from one budget rather than a new
          // one per attempt.
          //
          // `shared` is keyed on whether THIS run was handed the tracker's
          // signal, not on `request.config.share`: a share: true endpoint
          // called with per-call headers, per-call middleware or opaque params
          // declines to coalesce and arrives here with no `sharedSignal`, and
          // so does every `result.retry()`. Both are ordinary unshared calls
          // and must keep this caller's own `options.signal` and
          // `options.timeout`; keying on the config would silently drop them.
          // Only the operation half is built here: the per-caller half is the
          // share site's business, and constructing it here would leave a
          // retained `abort` listener on the caller's signal for a value this
          // branch never reads.
          const operation = operationBudget(
            options.timeout,
            request.config.timeout,
            options.signal,
            sharedSignal !== undefined
          )
          const callerSignal: AbortSignal | undefined = sharedSignal
            ? anySignal([sharedSignal, operation])
            : operation
          let dedupeController: AbortController | undefined

          // -----------------------------------------------------------------
          // Step 3: Define the core fetch function
          // -----------------------------------------------------------------
          // This is the innermost layer of the onion — the function that
          // actually calls fetch(). Middleware wraps this function; the last
          // middleware in the chain calls next() which invokes this core.
          //
          // The core function receives the (possibly mutated) middleware
          // context and performs:
          // a. Build the fetch RequestInit (method, headers, signal, body)
          // b. Call fetch with the resolved URL and init
          // c. Parse the response based on the configured responseType
          // d. Return a success or error Result
          //
          // Network errors (fetch throws) are caught and returned as
          // network error Results (status 0, no response).
          // -----------------------------------------------------------------
          const core = async (ctx: MiddlewareContext): Promise<Result<unknown>> => {
            try {
              // Register with the dedupe tracker on the first attempt that
              // reaches core() — we are committed to sending a request. Any
              // middleware that short-circuits above us returned without
              // reaching this point, so it cannot cancel a live request.
              //
              // The `!dedupeController` guard makes this once per execute(),
              // not once per attempt. retryMiddleware calls next() repeatedly;
              // if every attempt re-registered, an older request's retry would
              // abort a newer call for the same endpoint — the exact inverse
              // of dedupe's newest-wins contract. Registering once also means
              // a request that has been superseded stays cancelled: its retry
              // reuses the signal the newer call aborted.
              //
              // The signal we hand to track() is ctx.request.signal, not the
              // caller's: a middleware may have installed its own (a timeout,
              // a deadline), and dedupe must merge that rather than discard
              // it. Because registration happens only once, that field still
              // holds a live signal here — never a previous attempt's already
              // aborted dedupe signal.

              // A middleware may have replaced ctx.request.signal with its own
              // (a deadline, a circuit breaker), dropping the shared
              // controller — the same hazard the dedupe registration below
              // re-merges for. Without this, every sharer releasing no longer
              // aborts the real request: the socket stays open with nobody
              // waiting on it.
              if (sharedSignal && ctx.request.signal !== sharedSignal) {
                ctx.request.signal = anySignal([ctx.request.signal, sharedSignal])
              }

              if (request.config.dedupe && !dedupeController) {
                const tracked = dedupeTracker.track(name, ctx.request.signal ?? callerSignal)
                dedupeController = tracked.controller
                ctx.request.signal = tracked.signal
              }

              // Build the RequestInit object for the native fetch call.
              // We pull method, headers, and signal from the context (middleware
              // may have modified any of them) rather than closing over a signal
              // computed during setup — that's what lets a middleware replace
              // the signal (e.g. to implement a timeout) and have it actually
              // take effect.
              const fetchInit: RequestInit = {
                method: ctx.request.method,
                headers: ctx.request.headers,
                signal: ctx.request.signal
              }

              // Only set the body if there is one — GET/DELETE requests
              // typically have no body, and setting body to null/undefined
              // on those methods may cause issues with some fetch implementations.
              if (ctx.request.body !== null && ctx.request.body !== undefined) {
                fetchInit.body = ctx.request.body as BodyInit
              }

              const response = await fetch(ctx.request.url, fetchInit)

              // ---------------------------------------------------------------
              // Handle non-OK responses (4xx, 5xx)
              // ---------------------------------------------------------------
              // The server responded, but with an error status. We still have
              // the response (headers, body) available for inspection.
              // ---------------------------------------------------------------
              if (!response.ok) {
                // Try to parse the error response body using the same
                // responseType config. If parsing fails (e.g., server returned
                // HTML for a JSON endpoint), fall back to null.
                //
                // Same provenance concern as the success path below —
                // parseResponse performs the network body read here too, so
                // an abort landing while an ERROR body downloads (a slow
                // gateway's multi-kilobyte 502 page, say) must not be
                // misreported as a genuine 'http' error with a null body.
                // Without this check the classification is decided by the
                // server's status code rather than by what actually
                // happened — the same user action (navigating away) would
                // read as a real 5xx to retryOn and to onError.
                let body: unknown
                try {
                  body = await parseResponse(response, request.config.responseType)
                } catch (parseErr) {
                  const signal = ctx.request.signal
                  // Same "aborted now, not necessarily caused by" limitation
                  // as the success-path guard below — see its comment.
                  if (signal?.aborted === true) {
                    const error = new ApiError({
                      status: 0,
                      kind: abortKind(signal.reason) ?? 'abort',
                      statusText: '',
                      body: parseErr,
                      headers: new Headers(),
                      request: { method: ctx.request.method, url: ctx.request.url, params }
                    })
                    return createNetworkErrorResult(error, execute)
                  }
                  body = null
                }

                const error = new ApiError({
                  status: response.status,
                  kind: 'http',
                  statusText: response.statusText,
                  body,
                  headers: response.headers,
                  request: { method: ctx.request.method, url: ctx.request.url, params }
                })

                // retry points to execute() — re-enters the full pipeline
                return createErrorResult(error, response, execute)
              }

              // ---------------------------------------------------------------
              // Handle successful responses (2xx)
              // ---------------------------------------------------------------
              // Parse in its own try so a malformed body is reported as what it
              // is: the server responded, we could not read it. Falling through
              // to the network catch would report status 0 and discard the
              // Response, telling the caller they are offline when they are not.
              //
              // But `parseResponse` doesn't just parse — it performs the
              // network body read (`response.text()`/`.blob()`/etc.), so an
              // abort that lands after headers arrive (a component unmounting
              // mid-download) surfaces HERE, not in the outer catch below.
              // Provenance still applies: if our own signal is what aborted,
              // this is our cancellation, not "the server responded but the
              // body was unreadable" — same check as the outer catch, and the
              // same response:null/status:0 shape (createNetworkErrorResult)
              // so this matches what graphql.ts already does for the
              // identical scenario, which keeps its network read (`await
              // response.text()`) outside its own JSON.parse try for exactly
              // this reason — outside the parse-only try to fall through to
              // the outer catch's provenance handling.
              let data: unknown
              try {
                data = await parseResponse(response, request.config.responseType)
              } catch (parseErr) {
                const signal = ctx.request.signal
                // Known limitation: this checks "is the signal aborted NOW",
                // not "did the abort CAUSE this catch" — a genuinely
                // malformed payload that happens to arrive after the signal
                // was separately aborted is misclassified as the abort too.
                // Narrowing that requires parseResponse to distinguish its
                // own read failure from a parse failure across all five
                // response types, which the doc above already declines.
                if (signal?.aborted === true) {
                  const error = new ApiError({
                    status: 0,
                    kind: abortKind(signal.reason) ?? 'abort',
                    statusText: '',
                    body: parseErr,
                    headers: new Headers(),
                    request: { method: ctx.request.method, url: ctx.request.url, params }
                  })
                  return createNetworkErrorResult(error, execute)
                }
                const error = new ApiError({
                  kind: 'parse',
                  status: response.status,
                  statusText: response.statusText,
                  body: parseErr,
                  headers: response.headers,
                  request: { method: ctx.request.method, url: ctx.request.url, params }
                })
                return createErrorResult(error, response, execute)
              }

              return createSuccessResult(data, response, execute)
            } catch (err) {
              // ---------------------------------------------------------------
              // Handle network errors (fetch threw)
              // ---------------------------------------------------------------
              // This catches DNS failures, CORS errors, abort signals, offline
              // scenarios, and any other case where fetch itself throws instead
              // of returning a Response.
              //
              // Status 0 is the convention for "no HTTP response" — the error
              // body contains the native Error (TypeError for network, or
              // DOMException for abort) for debugging.
              //
              // Provenance over name-sniffing: if the signal we actually
              // handed to fetch is the one that's aborted, this failure IS
              // that cancellation — whatever `fetch` threw, including a
              // custom, non-`AbortError`-named reason a caller passed to
              // `ac.abort(reason)`. Only fall back to sniffing `err`'s own
              // shape when our signal is not the cause, for a genuine
              // network failure.
              // ---------------------------------------------------------------
              const signal = ctx.request.signal
              const kind = signal?.aborted === true
                ? (abortKind(signal.reason) ?? 'abort')
                : (abortKind(err) ?? 'network')
              const error = new ApiError({
                status: 0,
                kind,
                statusText: '',
                body: err,
                headers: new Headers(),
                request: { method: ctx.request.method, url: ctx.request.url, params }
              })

              return createNetworkErrorResult(error, execute)
            }
          }

          // -----------------------------------------------------------------
          // Step 4: Build the URL
          // -----------------------------------------------------------------
          // buildUrl handles three things:
          // a. Substitutes :param tokens in the path with matching param values
          // b. Appends remaining params as query string (when asQuery is true)
          // c. Returns the remaining (unconsumed) params for body serialization
          //
          // The asQuery flag is determined by the Request's shouldSerializeAsQuery
          // getter, which respects the bodyAs config override and HTTP method defaults.
          // -----------------------------------------------------------------
          const asQuery = request.shouldSerializeAsQuery

          // Check if the params is a non-plain-object body type (FormData, Blob, etc.)
          // before passing it through buildUrl. These types can't be decomposed into
          // key-value pairs for path param substitution or query string serialization.
          // When a special body type is detected, we skip buildUrl entirely for the
          // body portion and pass the params directly to serializeBody.
          const paramsIsSpecialBody = isSpecialBody(params)

          // For special body types, we still need to build the URL (for baseUrl + path),
          // but we pass an empty params object since there are no key-value pairs to
          // substitute or serialize as query params.
          const { url, remaining } = buildUrl(
            baseUrl,
            request.config.path,
            paramsIsSpecialBody ? {} : (params as Record<string, unknown>),
            asQuery
          )

          // -----------------------------------------------------------------
          // Step 5: Merge headers from all three layers
          // -----------------------------------------------------------------
          // The merge order determines precedence: later sources override earlier.
          // global (lowest) → per-request → per-call (highest)
          // -----------------------------------------------------------------
          const headers = mergeHeaders(globalHeaders, request.config.headers, options.headers)

          // -----------------------------------------------------------------
          // Step 6: Serialize the body (for non-query requests)
          // -----------------------------------------------------------------
          // For GET/DELETE (asQuery=true), all params went into the query string
          // via buildUrl, so there's no body to serialize.
          //
          // For POST/PUT/PATCH (asQuery=false), the remaining params (those not
          // consumed by path param substitution) become the request body.
          //
          // Special body types (FormData, Blob, etc.) bypass the remaining-params
          // logic and are passed directly to serializeBody, which handles them
          // with appropriate Content-Type detection.
          // -----------------------------------------------------------------
          let body: unknown | null = null
          if (!asQuery) {
            // Decide what to serialize: the original params (for special types)
            // or the remaining params after path substitution (for plain objects)
            const toSerialize = paramsIsSpecialBody ? params : remaining

            // Only serialize if there's something to serialize — avoid sending
            // empty bodies ({}) for endpoints with no body params.
            if (paramsIsSpecialBody || Object.keys(remaining).length > 0) {
              const serialized = serializeBody(toSerialize)
              body = serialized.body

              // Auto-set Content-Type if serializeBody determined one AND the
              // caller hasn't explicitly set one (per-call or per-request headers
              // should be able to override the auto-detected type).
              // Note: For FormData, contentType is null because the browser needs
              // to set the multipart boundary automatically.
              if (serialized.contentType && !headers.has('Content-Type')) {
                headers.set('Content-Type', serialized.contentType)
              }
            }
          }

          // -----------------------------------------------------------------
          // Step 7: Build the middleware context
          // -----------------------------------------------------------------
          // The context object is what every middleware receives. It contains
          // all information about the request: method, URL, original path,
          // params, headers, and serialized body. Middleware can read and
          // modify headers and body before the fetch executes.
          // -----------------------------------------------------------------
          const context: MiddlewareContext = {
            request: {
              method: request.config.method,
              url,
              path: request.config.path,
              params,
              headers,
              body,
              signal: callerSignal
            },
            requestName: name
          }

          // -----------------------------------------------------------------
          // Step 8: Compose middleware and execute
          // -----------------------------------------------------------------
          // composeMiddleware creates the onion chain: each middleware wraps
          // the next, with the core fetch function at the center.
          // skipMiddleware filters out specific middleware by reference (===).
          // -----------------------------------------------------------------
          const composed = composeMiddleware(allMiddleware, core, options.skipMiddleware ?? [])
          // composeMiddleware has no guard of its own, and execute()'s try/catch
          // only covers the synchronous setup above — so an async middleware
          // that throws escapes as a rejection and breaks the library's one
          // headline guarantee. Convert it here, before the post-execution
          // hook, so the failure reaches onError like any other.
          //
          // A middleware that throws SYNCHRONOUSLY (a plain, non-async
          // function) never gets as far as handing back a promise for
          // `.catch` to attach to — composed(context) itself throws, before
          // this statement finishes evaluating. The surrounding try/catch
          // below already turns that into a Result, but with fallback kind
          // 'network' — correct for a setup error (e.g. buildUrl's
          // TypeError), wrong for a throwing middleware. Catching it here
          // too, right alongside the async case, keeps both classified as
          // 'middleware' and routed through the same post-execution hook.
          let resultPromise: Promise<Result<unknown>>
          try {
            resultPromise = composed(context).catch(
              (err: unknown) => buildFailedResult(err, context.request.signal, 'middleware')
            )
          } catch (err) {
            resultPromise = Promise.resolve(buildFailedResult(err, context.request.signal, 'middleware'))
          }

          // -----------------------------------------------------------------
          // Step 9: Post-execution hooks (dedupe cleanup + onError)
          // -----------------------------------------------------------------
          // After the middleware chain completes (with any result), we:
          // a. Clear the dedupe tracker for this endpoint (if dedupe is enabled)
          //    so the next call starts fresh without aborting a completed request
          // b. Fire the onError callback if the final result has an error
          //    (only fires on final error — if retry middleware recovered, no fire)
          // -----------------------------------------------------------------
          return resultPromise.then(result => {
            // This operation now has a Result. Announce it before reporting
            // anything: a sharer whose own signal is aborted from inside the
            // `onError` below must be able to tell, synchronously, that it was
            // never left waiting. Every later hop is too late — see the share
            // site's `onAbort`.
            // `retry` hands this very function to consumers, so the second
            // parameter can receive anything a caller's call shape supplies —
            // `arr.map(result.retry)` passes the index. Guard on the type
            // rather than trusting the shape: a non-function here would throw
            // from inside the one path that must always produce a Result.
            // A function that itself throws is guarded too, for the same
            // reason: this hook must never fail a request that already has a
            // perfectly good Result, and a throw here is exactly the kind of
            // consumer-supplied misbehaviour that would resurrect the
            // rejection path the share site's defense-in-depth handlers exist
            // to catch (see ShareTracker's callers in this file).
            if (typeof onSettled === 'function') {
              try { onSettled() } catch { /* a settlement callback must not fail a request */ }
            }

            // Clean up dedupe tracking after the request completes.
            // This must happen before onError so that onError handlers can
            // immediately fire a new request without triggering a dedupe abort.
            //
            // dedupeController is only assigned inside core() — if every
            // middleware short-circuited and core() never ran (e.g. a cache
            // hit), it stays undefined here. clear() with no controller
            // deletes the map entry unconditionally, which would be wrong in
            // that case: it could delete the entry belonging to a genuinely
            // in-flight request registered by someone else under the same
            // name. So only clear when this execute() actually registered.
            if (request.config.dedupe && dedupeController) dedupeTracker.clear(name, dedupeController)

            // Fire the global error handler if the final result has an error.
            // This is the "last chance" error hook — middleware has already had
            // its opportunity to handle/recover the error. Guarded: a throwing
            // handler must not reject a promise that already holds a Result.
            //
            // Abandonment is not itself a failure: the tracker aborted this
            // request because nobody is waiting on it any more, not because
            // anything went wrong. This guard exists so that outcome doesn't
            // get reported here as an operation-level failure. `sharedSignal`
            // is consulted rather than the error's body because the tracker's
            // abort reason is authoritative: it says *why the request ended*,
            // whereas the error body is whatever `fetch` (or a middleware
            // reacting to the abort) happened to produce.
            //
            // This is NOT "every caller has already received and reported its
            // own Result" — that used to be true, but Task 10 (`onError` no
            // longer fires for `error.kind === 'abort'`) broke it. A plain
            // abort-flavoured give-up is dropped by `fireOnError`'s own kind
            // check regardless of this guard, so it produces ZERO reports —
            // the caller still gets a real `ErrorResult` back, it just never
            // reaches `onError`. `tests/share.test.ts`'s "two sharers both
            // abort" (row 2) pins exactly that: `kinds` ends up `[]`. Only a
            // give-up whose kind survives `fireOnError` (a genuine timeout) is
            // actually reported, by that caller's own `onAbort` — see "two
            // sharers both time out" (row 2b) in the same file.
            //
            // What this guard does still guarantee: it is never a *second*
            // report of a failure a sharer's own `onAbort` already reported or
            // will report for the SAME operation-level outcome. Two legs, both
            // load-bearing:
            //
            //  1. `release()` has exactly one call site — the share site's
            //     `onAbort` — and the `fireOnError` call there is `if
            //     (!hasSettled()) fireOnError(...)`, not unconditional. The
            //     guard can only suppress that caller's own report; it never
            //     adds one, so it can never turn into a SECOND report for
            //     the same operation-level outcome.
            //  2. A sharer with no `perCaller` budget never releases at all.
            //     It takes the `if (!perCaller) return promise.then(...)`
            //     fast path, so it holds its reference for as long as it
            //     waits, which keeps `refs > 0` and makes abandonment
            //     unreachable while any such caller is still waiting.
            //
            // Leg 2 is why abandonment can never fire out from under a caller
            // that has no give-up path of its own. Adding a second `release()`
            // call site, or giving that fast path one, breaks the invariant
            // this suppression assumes.
            const abandoned = sharedSignal?.aborted === true && isAbandoned(sharedSignal.reason)
            if (result.error && !abandoned) fireOnError(result.error as ApiError)

            return result
          })
        } catch (err) {
          // -----------------------------------------------------------------
          // Catch synchronous errors
          // -----------------------------------------------------------------
          // This catches errors thrown synchronously during the request setup
          // phase (before the async middleware chain starts). The most common
          // case is TypeError from buildUrl when a nested object is passed
          // as a query string parameter.
          //
          // By catching here and returning a Result, we maintain the "never
          // throws" contract — callers always get a Result, never an
          // unhandled rejection.
          // -----------------------------------------------------------------
          // Fire onError for synchronous errors too — they're still errors.
          // `undefined`, not `callerSignal`, is passed here for two reasons:
          // (a) `callerSignal` is a `const` scoped inside the `try` above and
          // is simply unreachable from this `catch` block; and (b), the
          // reason that matters — this is a deliberate policy, not a
          // limitation to route around by hoisting it into scope. A bug in
          // request *setup* (buildUrl's TypeError, a BigInt timeout reaching
          // Math.min) must always report as the setup bug it is, even when
          // the caller has ALSO aborted around the same time — silently
          // reclassifying a real setup failure as 'abort' just because a
          // signal happens to be aborted would hide it from onError.
          return Promise.resolve(failedResult(err, undefined, 'network'))
        }
      }

      // -----------------------------------------------------------------------
      // Coalescing (share: true)
      // -----------------------------------------------------------------------
      // Coalescing wraps the whole chain — unlike dedupe, which registers
      // inside core(). Running the middleware once for ten callers is the
      // actual saving; ten auth injections and ten cache lookups for one
      // network call would be most of the cost.
      //
      // Per-call headers or middleware change *what* is requested, so such a
      // call never shares — it always gets its own execute(). A per-call
      // signal or timeout only changes *who is waiting*, so it does not
      // disable sharing: it is observed for this caller alone, below.
      //
      // Opaque-body params (FormData, Blob, ArrayBuffer, URLSearchParams) are
      // excluded too: stableStringify falls through to Object.keys() for any
      // object, which returns [] for all four of those types regardless of
      // content, so two calls with genuinely different payloads would
      // otherwise collide on the same share key, coalesce into one request,
      // and hand one caller the response to the other's payload — the exact
      // "security-shaped bug" this doc warns about for per-call headers,
      // reachable through a different vector. Declining to share is always
      // safe; corrupting a response never is.
      //
      // A raw string is deliberately NOT excluded here (unlike
      // isSpecialBody, used below for body/URL handling): stableStringify
      // keys a string correctly, via JSON.stringify, so a string-param
      // endpoint is soundly coalescable. Excluding it (as 2.2.0 did, sharing
      // isSpecialBody for this check) silently disabled sharing for such
      // endpoints — fixed in 2.2.1 by using isOpaqueParams here instead.
      //
      // The whole block is wrapped in try/catch for the same reason execute()
      // is: it runs in the bare body of the api method, so anything thrown
      // here — by isSpecialBody, stableStringify, timeoutSignalFor, or the
      // synchronous part of the Promise executor — escapes as a rejection
      // rather than a Result. This is the one region of the request path where
      // "every call returns a Result" would otherwise not be enforced by
      // construction.
      // -----------------------------------------------------------------------
      try {
        // Emptiness, not truthiness: `headers: {}` and `middleware: []` are
        // both truthy, and neither changes what is requested, so neither is a
        // reason to decline coalescing.
        const canShare =
          request.config.share === true &&
          isEmptyHeaders(options.headers) &&
          (options.middleware === undefined || options.middleware.length === 0) &&
          !isOpaqueParams(params)
        if (!canShare) return execute()

        const shareKey = `${name}|${stableStringify(params)}`

        // This caller's own signal and per-call timeout, kept entirely separate
        // from the signal the real fetch runs on. It bounds only whether THIS
        // caller keeps waiting — it must never reach into the shared request.
        //
        // Deliberately *not* `request.config.timeout`: that one belongs to the
        // operation, is shared by every caller, and is applied inside execute()
        // against the request's own start time. `perCallerBudget` is the half
        // of the budget that knows only about this caller — asking for exactly
        // that half is what keeps the two straight, and avoids allocating an
        // operation deadline nobody here reads. Computed before acquire() so a
        // throw from here cannot strand a shared request that this caller then
        // never releases.
        const perCaller = perCallerBudget(options.timeout, options.signal)

        // acquire() either starts the real request (first caller — exec is
        // called with the tracker's own refcounted signal, which becomes the
        // signal that actually drives fetch) or joins an identical one already
        // in flight. Either way every sharer gets the same promise back.
        const { promise, release, hasSettled } = shareTracker.acquire(shareKey, (signal, markSettled) =>
          execute(signal, markSettled)
        )

        // execute() converts synchronous errors to Results, but a *rejection*
        // from the middleware chain (an async middleware that throws) escapes
        // it and would arrive here as a bare reason. Handing that to a caller
        // as though it were a Result is worse than the rejection it replaces:
        // `const { data, error } = await api.get(...)` then yields
        // undefined/undefined, `if (error)` is false, and the consumer carries
        // on as if the call had succeeded with no data. Convert it instead.
        //
        // No `perCaller` signal/timeout means there's no separate give-up path
        // for this caller to race against — it can only ever learn its result
        // from `promise` settling, so this is the whole story for it, same as
        // it always reported.
        //
        // As of the never-throws fix (Task 9), `execute()` itself converts a
        // middleware rejection into a Result before it ever gets here — so
        // `promise` has no live producer of a rejection today, and this arm
        // is dead in normal operation. Kept as defense-in-depth: "execute()
        // never rejects" is an invariant held by code, not by types. The
        // invariant itself — not this now-unreachable arm — is what is
        // pinned, by `tests/never-throws.test.ts`: if a future change lets
        // `execute()` reject again, those tests fail loudly, and this arm
        // becomes live again to catch exactly the rejection they'd be
        // failing on.
        if (!perCaller) return promise.then(r => r, (err: unknown) => failedResult(err, undefined, 'network'))

        // Race this caller's own giving-up against the shared result settling.
        // Giving up calls release(), which only decrements the refcount — the
        // underlying request is aborted by ShareTracker itself, and only once
        // every sharer (including this one) has released.
        return new Promise<Result<unknown>>(resolve => {
          let done = false
          const finish = (r: Result<unknown>): void => {
            if (done) return
            done = true
            perCaller.removeEventListener('abort', onAbort)
            resolve(r)
          }

          promise.then(
            r => finish(r),
            (err: unknown) => {
              // Fix 2 (2.2.1, "cross-kind double report"): this caller may
              // already be `done` — most commonly because `onAbort` below
              // already gave it a Result. `finish` would discard whatever we
              // build here anyway, but `failedResult` reports to onError as a
              // side effect of being built, which would report the SAME
              // underlying give-up a second time, under a DIFFERENT kind
              // ('network' here vs. whatever `onAbort` already reported).
              // Bail before constructing anything.
              //
              // Same status as the `!perCaller` arm above: since Task 9,
              // `execute()` converts a middleware rejection into a Result
              // before `promise` can ever reject, so this whole rejection
              // handler — the `done` bail included — has no live producer
              // today. Kept as defense-in-depth for the same reason: the
              // no-reject invariant lives in code, not in types, and it is
              // that invariant — pinned by `tests/never-throws.test.ts` —
              // rather than this arm itself, that is what is actually
              // tested. If `execute()` ever rejects again, those tests fail
              // loudly, and this bail (and the arm around it) is what
              // catches the fallout.
              if (done) return
              finish(failedResult(err, undefined, 'network'))
            }
          )

          // This caller gave up. That is its own failure, distinct from the
          // operation's, and this path builds its Result directly rather than
          // through execute()'s hook — so it reports, always.
          //
          // Unconditional is now correct because abandonment is explicit: if
          // this release was the last one, the tracker aborts the shared
          // request with ABANDONED and execute()'s hook stays silent. Before
          // that sentinel existed this had to guess whether the delegate would
          // report, and guessed wrong in both directions — twice producing a
          // duplicate, twice producing zero.
          //
          // "Gave up" is the load-bearing word. A caller whose operation has
          // already produced a Result was never left waiting: its abort is
          // vestigial, and the operation has already reported that Result
          // itself. The realistic source is an `onError` handler that cancels
          // the rest of a batch on the first failure — it runs inside the
          // hook above, so the abort lands while this listener is still
          // armed. Reporting then produces two reports ('http' and 'abort')
          // where an identical non-shared call produces one.
          //
          // `hasSettled()` is the operation's own synchronous answer, taken
          // before it reported. Neither `done` nor any flag set from
          // `promise.then` can serve here: the hook fires ~3 microtask hops
          // ahead of them, so both are still false in exactly the window this
          // guards. The Result handed back is unchanged either way — only the
          // report is suppressed.
          const onAbort = (): void => {
            release()
            const result = buildFailedResult(perCaller.reason, perCaller, 'abort')
            if (!hasSettled()) fireOnError(result.error as ApiError)
            finish(result)
          }

          if (perCaller.aborted) onAbort()
          else perCaller.addEventListener('abort', onAbort, { once: true })
        })
      } catch (err) {
        // Setup for the share path itself threw (e.g. a BigInt timeout
        // reaching Math.min in perCallerBudget) — before acquire(), so there
        // is no operative signal yet to check provenance against.
        return Promise.resolve(failedResult(err, undefined, 'network'))
      }
    }
  }

  // Cast the dynamically-built object to the fully-typed Api type.
  // The types are correct because each generated method's params/response
  // match the Request's generics — the cast is safe.
  return api as Api<TRequests>
}
