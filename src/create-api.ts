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
import { buildUrl } from './utils/path-params.js'
import { serializeBody } from './utils/serialize.js'
import { DedupeTracker } from './utils/dedupe.js'
import { mergeHeaders } from './utils/headers.js'
import type { ApiConfig, CallOptions, Middleware, MiddlewareContext, Result, ResponseType } from './types.js'

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtractParams<R> = R extends Request<infer P, any> ? P : never

/**
 * Extracts the TResponse type from a Request instance.
 *
 * Given `Request<{ id: string }, User>`, this resolves to `User`.
 * Used internally by the Api mapped type to infer method return types.
 *
 * @typeParam R - A Request instance (or anything — returns `never` for non-Request types).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApi<TRequests extends Record<string, Request<any, any>>>(
  config: ApiConfig<TRequests>
): Api<TRequests> {
  // Destructure the config for convenience. Default globalMiddleware to an
  // empty array so we don't need null checks throughout the function.
  const { baseUrl, requests, middleware: globalMiddleware = [], headers: globalHeaders, onError } = config

  // ---------------------------------------------------------------------------
  // Dedupe tracker — shared across all endpoints in this API instance.
  //
  // Each endpoint that has dedupe: true will use this tracker to auto-cancel
  // previous in-flight requests. The tracker is per-createApi (not global)
  // because different API instances should have independent dedupe state.
  // ---------------------------------------------------------------------------
  const dedupeTracker = new DedupeTracker()

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
       */
      const execute = (): Promise<Result<unknown>> => {
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
          // When dedupe is enabled for this request, we route the signal
          // through the DedupeTracker. This does two things:
          // 1. Aborts any previous in-flight request for this endpoint
          // 2. Merges the caller's signal (if any) so external abort also works
          //
          // When dedupe is disabled, the caller's signal (if any) is used
          // directly — no tracking overhead.
          // -----------------------------------------------------------------
          let effectiveSignal: AbortSignal | undefined = options.signal
          if (request.config.dedupe) {
            effectiveSignal = dedupeTracker.track(name, options.signal)
          }

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
              // Build the RequestInit object for the native fetch call.
              // We pull method and headers from the context (middleware may
              // have modified them) and use the effectiveSignal computed above.
              const fetchInit: RequestInit = {
                method: ctx.request.method,
                headers: ctx.request.headers,
                signal: effectiveSignal
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
                let body: unknown
                try {
                  body = await parseResponse(response, request.config.responseType)
                } catch {
                  body = null
                }

                const error = new ApiError({
                  status: response.status,
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
              const data = await parseResponse(response, request.config.responseType)
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
              // ---------------------------------------------------------------
              const error = new ApiError({
                status: 0,
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
          const isSpecialBody =
            params instanceof FormData ||
            params instanceof Blob ||
            params instanceof ArrayBuffer ||
            params instanceof URLSearchParams ||
            typeof params === 'string'

          // For special body types, we still need to build the URL (for baseUrl + path),
          // but we pass an empty params object since there are no key-value pairs to
          // substitute or serialize as query params.
          const { url, remaining } = buildUrl(
            baseUrl,
            request.config.path,
            isSpecialBody ? {} : (params as Record<string, unknown>),
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
            const toSerialize = isSpecialBody ? params : remaining

            // Only serialize if there's something to serialize — avoid sending
            // empty bodies ({}) for endpoints with no body params.
            if (isSpecialBody || Object.keys(remaining).length > 0) {
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
              body
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
          const resultPromise = composed(context)

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
            // Clean up dedupe tracking after the request completes.
            // This must happen before onError so that onError handlers can
            // immediately fire a new request without triggering a dedupe abort.
            if (request.config.dedupe) dedupeTracker.clear(name)

            // Fire the global error handler if the final result has an error.
            // This is the "last chance" error hook — middleware has already had
            // its opportunity to handle/recover the error.
            if (result.error && onError) onError(result.error as ApiError)

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
          const error = new ApiError({
            status: 0,
            statusText: '',
            body: err,
            headers: new Headers(),
            request: { method: request.config.method, url: `${baseUrl}${request.config.path}`, params }
          })

          // Fire onError for synchronous errors too — they're still errors
          if (onError) onError(error)

          return Promise.resolve(createNetworkErrorResult(error, execute))
        }
      }

      // Kick off the execute function for the initial call
      return execute()
    }
  }

  // Cast the dynamically-built object to the fully-typed Api type.
  // The types are correct because each generated method's params/response
  // match the Request's generics — the cast is safe.
  return api as Api<TRequests>
}
