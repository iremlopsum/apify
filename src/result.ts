// =============================================================================
// result.ts — ApiError class and Result factory helpers
// =============================================================================
//
// This module provides the core error type and factory functions for creating
// Result objects. Every API call in the library returns a Result<TResponse>
// rather than throwing — this eliminates the need for try/catch at call sites.
//
// The three factory functions correspond to the three outcomes of an API call:
// 1. Success (HTTP 2xx) → createSuccessResult
// 2. HTTP error (4xx, 5xx) → createErrorResult (has an HTTP Response)
// 3. Network error (offline, DNS, abort) → createNetworkErrorResult (no Response)
// =============================================================================

import type { Result } from './types.js'

// -----------------------------------------------------------------------------
// ApiError Options
// -----------------------------------------------------------------------------

/**
 * Properties required to construct an ApiError instance.
 *
 * This interface exists to keep the ApiError constructor clean — instead of
 * positional arguments, we use a single options object for clarity at call sites.
 */
interface ApiErrorOptions {
  /** HTTP status code (e.g., 404, 500). Use 0 for network errors and aborts. */
  status: number

  /** HTTP status text (e.g., 'Not Found'). Use '' for network errors and aborts. */
  statusText: string

  /**
   * The parsed response body from the server.
   *
   * For HTTP errors, this is whatever the server returned (often a JSON error object).
   * For network errors, this is the native Error that fetch threw.
   * For aborted requests, this is a DOMException with name 'AbortError'.
   */
  body: unknown

  /**
   * Response headers from the server.
   * For network errors (no response), this should be an empty Headers object.
   */
  headers: Headers

  /**
   * Metadata about the request that caused this error.
   * Useful for logging, debugging, and error reporting.
   */
  request: {
    method: string
    url: string
    params: unknown
  }
}

// -----------------------------------------------------------------------------
// ApiError Class
// -----------------------------------------------------------------------------

/**
 * Structured error returned in `Result.error` for both HTTP and network failures.
 *
 * This is NOT a subclass of `Error` — it's a plain class that stores error
 * details in a structured way. This is intentional: ApiError represents an
 * API-level error (not a programming error), and we don't need stack traces
 * or error inheritance for that use case.
 *
 * Two categories of errors produce an ApiError:
 *
 * **HTTP errors** (server responded with 4xx or 5xx):
 * - `status` is the HTTP status code (e.g., 404, 500)
 * - `statusText` is the HTTP status text (e.g., 'Not Found')
 * - `body` is the parsed response body (e.g., `{ message: 'Not found' }`)
 * - `headers` contains the response headers
 *
 * **Network errors** (no HTTP response at all):
 * - `status` is 0 (convention for "no HTTP status")
 * - `statusText` is '' (empty string)
 * - `body` is the native Error or DOMException that caused the failure
 * - `headers` is an empty Headers object
 *
 * @example
 * ```ts
 * const { error } = await api.getUser({ id: '42' })
 * if (error) {
 *   if (error.status === 0) {
 *     // Network error — user is probably offline
 *   } else if (error.status === 404) {
 *     // User not found
 *   }
 * }
 * ```
 */
export class ApiError {
  /** HTTP status code, or 0 for network errors and aborted requests. */
  readonly status: number

  /** HTTP status text, or '' for network errors and aborted requests. */
  readonly statusText: string

  /**
   * Parsed response body, Error for network failures, DOMException for aborts.
   * The type is `unknown` because the server can return anything.
   */
  readonly body: unknown

  /**
   * Response headers. Empty Headers object when no HTTP response exists
   * (network errors, aborts).
   */
  readonly headers: Headers

  /**
   * Metadata about the request that caused this error.
   * Includes the method, fully resolved URL, and the original params object.
   */
  readonly request: { method: string; url: string; params: unknown }

  constructor(options: ApiErrorOptions) {
    this.status = options.status
    this.statusText = options.statusText
    this.body = options.body
    this.headers = options.headers
    this.request = options.request
  }
}

// -----------------------------------------------------------------------------
// Result Factory Functions
// -----------------------------------------------------------------------------
// These factories enforce the Result shape contract:
// - Success: data is populated, error is null
// - Error: data is null, error is populated
// - All results include a retry function for re-executing the request
// -----------------------------------------------------------------------------

/**
 * Create a successful Result with parsed response data.
 *
 * Used when the HTTP response has a 2xx status code and the body was
 * successfully parsed according to the request's `responseType`.
 *
 * @typeParam TResponse - The type of the parsed response data.
 * @param data - The parsed response data.
 * @param response - The raw HTTP Response object (for status, headers, etc.).
 * @param retry - Function to re-execute the request from the outermost middleware.
 * @returns A Result with `data` populated and `error` as null.
 */
export function createSuccessResult<TResponse>(
  data: TResponse,
  response: Response,
  retry: () => Promise<Result<TResponse>>
): Result<TResponse> {
  return { data, error: null, response, retry }
}

/**
 * Create an error Result for HTTP errors (server responded, but with an error status).
 *
 * Used when the HTTP response has a non-2xx status code (4xx, 5xx).
 * The raw Response is still available because the server DID respond — the
 * caller might need response headers or want to inspect the raw body.
 *
 * @typeParam TResponse - The expected response type (data will be null).
 * @param error - The structured ApiError with status, body, and request metadata.
 * @param response - The raw HTTP Response object.
 * @param retry - Function to re-execute the request from the outermost middleware.
 * @returns A Result with `error` populated and `data` as null.
 */
export function createErrorResult<TResponse>(
  error: ApiError,
  response: Response,
  retry: () => Promise<Result<TResponse>>
): Result<TResponse> {
  return { data: null, error, response, retry }
}

/**
 * Create an error Result for network failures (no HTTP response exists).
 *
 * Used when fetch itself throws — DNS failure, offline, CORS error, abort, etc.
 * The `response` field is null because no HTTP response was received.
 *
 * @typeParam TResponse - The expected response type (data will be null).
 * @param error - The structured ApiError (status 0, body is the native Error).
 * @param retry - Function to re-execute the request from the outermost middleware.
 * @returns A Result with `error` populated and both `data` and `response` as null.
 */
export function createNetworkErrorResult<TResponse>(
  error: ApiError,
  retry: () => Promise<Result<TResponse>>
): Result<TResponse> {
  return { data: null, error, response: null, retry }
}
