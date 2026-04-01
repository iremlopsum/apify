// =============================================================================
// create-api.test.ts — Tests for the createApi constructor
// =============================================================================
//
// createApi is the heart of the apify library — it takes a set of Request
// definitions and wires them together with middleware, headers, and fetch into
// a typed API object where each key becomes a callable method.
//
// These tests verify:
// 1. The returned API object has methods matching the request keys
// 2. GET requests serialize params as query strings
// 3. POST requests serialize params as JSON body
// 4. Path params (:id) are substituted into the URL
// 5. Non-OK responses (4xx, 5xx) produce ApiError results
// 6. Network errors (offline, DNS, etc.) produce ApiError with status 0
// 7. The onError callback fires only on final errors, not on success
// 8. Endpoints with Record<string, never> params can omit the params argument
// 9. Header merging follows global < per-request < per-call precedence
// 10. Abort signals are forwarded to fetch
// 11. Non-JSON response types (text, blob, etc.) are parsed correctly
// 12. The retry() function re-executes through the full middleware chain
// 13. Middleware runs in global → per-request → per-call order
// 14. skipMiddleware filters out specific middleware by reference
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { ApiError } from '../src/result.js'
import type { Middleware } from '../src/types.js'

// ---------------------------------------------------------------------------
// Global mock for fetch
// ---------------------------------------------------------------------------
// We mock fetch globally so every test can control the HTTP response.
// Each test uses mockFetch.mockResolvedValueOnce (or similar) to set up
// the expected response for that specific test case.
// ---------------------------------------------------------------------------
const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Helper: mock a successful JSON response from fetch.
 *
 * Creates a proper Response object with JSON content, which is what fetch
 * returns in real usage. The status defaults to 200 OK.
 *
 * @param data - The data to JSON-stringify as the response body.
 * @param status - HTTP status code (defaults to 200).
 */
function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(data), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' }
    })
  )
}

/**
 * Helper: mock a network error from fetch.
 *
 * In real usage, fetch throws a TypeError for network failures (offline,
 * DNS failure, CORS block, etc.). This helper simulates that behavior.
 *
 * @param message - The error message (defaults to 'Failed to fetch').
 */
function mockNetworkError(message = 'Failed to fetch') {
  mockFetch.mockRejectedValueOnce(new TypeError(message))
}

// =============================================================================
// Core createApi tests
// =============================================================================

describe('createApi', () => {
  it('creates an API object with methods matching request keys', () => {
    // The most basic contract: each key in the requests record becomes a
    // callable function on the returned API object.
    const getItems = new Request<Record<string, never>, unknown[]>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    expect(typeof api.getItems).toBe('function')
  })

  it('makes a GET request with query params', async () => {
    // GET requests should serialize params as query string by default.
    // The Request class's shouldSerializeAsQuery returns true for GET,
    // so buildUrl is called with asQuery=true.
    const getItems = new Request<{ page: number }, { items: string[] }>({
      method: 'GET',
      path: '/items'
    })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    mockJsonResponse({ items: ['a', 'b'] })
    const { data, error } = await api.getItems({ page: 1 })

    expect(error).toBeNull()
    expect(data).toEqual({ items: ['a', 'b'] })
    // Verify the URL includes the query string and the method is GET
    expect(mockFetch).toHaveBeenCalledWith('/api/items?page=1', expect.objectContaining({ method: 'GET' }))
  })

  it('makes a POST request with JSON body', async () => {
    // POST requests should serialize params as JSON body by default.
    // The Request class's shouldSerializeAsQuery returns false for POST,
    // so serializeBody is called with the remaining params.
    const createItem = new Request<{ name: string }, { id: number }>({
      method: 'POST',
      path: '/items'
    })
    const api = createApi({ baseUrl: '/api', requests: { createItem } })

    mockJsonResponse({ id: 1 })
    const { data } = await api.createItem({ name: 'test' })

    expect(data).toEqual({ id: 1 })
    // Verify the request body is JSON-stringified and Content-Type is set
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/items')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"test"}')
    expect(init.headers.get('Content-Type')).toBe('application/json')
  })

  it('substitutes path params', async () => {
    // Path params like :id should be replaced with the corresponding value
    // from the params object, and the consumed param should NOT appear in
    // the query string or body.
    const getItem = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/items/:id'
    })
    const api = createApi({ baseUrl: '/api', requests: { getItem } })

    mockJsonResponse({ name: 'test' })
    await api.getItem({ id: '42' })

    // The :id token should be replaced with '42' in the URL
    expect(mockFetch).toHaveBeenCalledWith('/api/items/42', expect.any(Object))
  })

  it('returns ApiError on non-ok response', async () => {
    // When the server responds with a non-2xx status, the result should
    // have data=null and error=ApiError with the status code and body.
    const getItem = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/items/:id'
    })
    const api = createApi({ baseUrl: '/api', requests: { getItem } })

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not found' }), { status: 404, statusText: 'Not Found' })
    )
    const { data, error } = await api.getItem({ id: '99' })

    expect(data).toBeNull()
    expect(error).toBeInstanceOf(ApiError)
    expect(error!.status).toBe(404)
    expect(error!.body).toEqual({ message: 'Not found' })
  })

  it('returns ApiError with status 0 on network error', async () => {
    // Network errors (offline, DNS failure, CORS, etc.) produce status 0.
    // The response field should be null because no HTTP response was received.
    const getItems = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    mockNetworkError()
    const { data, error, response } = await api.getItems()

    expect(data).toBeNull()
    expect(response).toBeNull()
    expect(error).toBeInstanceOf(ApiError)
    expect(error!.status).toBe(0)
  })

  it('calls onError when final result has an error', async () => {
    // The onError callback fires after the full middleware chain completes,
    // only when the final result contains an error. This allows centralized
    // error handling (e.g., redirect to login on 401, report to Sentry).
    const onError = vi.fn()
    const getItems = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, onError })

    mockFetch.mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Error' }))
    await api.getItems()

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toBeInstanceOf(ApiError)
  })

  it('does not call onError on success', async () => {
    // Verify that onError is NOT called for successful responses.
    // If a retry middleware recovers a 5xx to a 200, onError should not fire.
    const onError = vi.fn()
    const getItems = new Request<Record<string, never>, unknown[]>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, onError })

    mockJsonResponse([])
    await api.getItems()

    expect(onError).not.toHaveBeenCalled()
  })

  it('allows empty params to be omitted', async () => {
    // When TParams is Record<string, never>, the params argument should
    // be optional. This is the common case for health checks, simple GETs,
    // and endpoints that don't need any parameters.
    const health = new Request<Record<string, never>, { ok: boolean }>({
      method: 'GET',
      path: '/health'
    })
    const api = createApi({ baseUrl: '/api', requests: { health } })

    mockJsonResponse({ ok: true })
    // Note: no params argument passed — this should work without error
    const { data } = await api.health()

    expect(data).toEqual({ ok: true })
  })

  it('merges headers: global < per-request < per-call', async () => {
    // Headers are merged in three layers, with later layers overriding earlier:
    // 1. Global headers (from createApi config) — lowest priority
    // 2. Per-request headers (from Request config) — overrides global
    // 3. Per-call headers (from CallOptions) — highest priority
    //
    // The X-Layer header is set at all three levels to verify override behavior.
    // The X-Global, X-Request, and X-Call headers verify that non-conflicting
    // headers from all levels are preserved.
    const getItems = new Request<Record<string, never>, unknown>({
      method: 'GET',
      path: '/items',
      headers: { 'X-Layer': 'request', 'X-Request': 'yes' }
    })
    const api = createApi({
      baseUrl: '/api',
      requests: { getItems },
      headers: { 'X-Layer': 'global', 'X-Global': 'yes' }
    })

    mockJsonResponse([])
    await api.getItems({}, { headers: { 'X-Layer': 'call', 'X-Call': 'yes' } })

    const headers = mockFetch.mock.calls[0][1].headers as Headers
    // X-Layer should be 'call' because per-call is highest priority
    expect(headers.get('X-Layer')).toBe('call')
    // All non-conflicting headers should be preserved
    expect(headers.get('X-Global')).toBe('yes')
    expect(headers.get('X-Request')).toBe('yes')
    expect(headers.get('X-Call')).toBe('yes')
  })

  it('passes signal to fetch', async () => {
    // When a caller passes an AbortSignal via CallOptions, it should be
    // forwarded to the fetch call so that aborting the signal cancels the
    // HTTP request.
    const getItems = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    const controller = new AbortController()
    mockJsonResponse([])
    await api.getItems({}, { signal: controller.signal })

    // The signal passed to fetch should be the same reference as the caller's
    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('parses text response type', async () => {
    // When responseType is 'text', the response body should be returned as
    // a raw string instead of being JSON-parsed.
    const getHealth = new Request<Record<string, never>, string>({
      method: 'GET',
      path: '/health',
      responseType: 'text'
    })
    const api = createApi({ baseUrl: '/api', requests: { getHealth } })

    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    const { data } = await api.getHealth()

    expect(data).toBe('OK')
  })

  it('retry re-executes with full middleware chain', async () => {
    // The retry() function should re-enter the full middleware chain from
    // the outermost layer. This ensures that auth tokens are re-injected,
    // logging fires again, etc. — not just the fetch.
    const callOrder: string[] = []
    const mw: Middleware = async (ctx, next) => {
      callOrder.push('mw')
      return next()
    }

    const getItems = new Request<Record<string, never>, string[]>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [mw] })

    // First call: 500 error
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }))
    const { retry } = await api.getItems()

    // Retry: 200 success
    mockJsonResponse(['a'])
    const { data } = await retry()

    // Middleware should have run twice (once for original, once for retry)
    expect(callOrder).toEqual(['mw', 'mw'])
    expect(data).toEqual(['a'])
  })
})

// =============================================================================
// Middleware integration tests
// =============================================================================

describe('createApi middleware integration', () => {
  it('runs global → per-request → per-call middleware in order', async () => {
    // Middleware execution order is critical: global middleware runs first
    // (outermost onion layer), then per-request, then per-call (innermost).
    // This allows global middleware to wrap everything (e.g., auth, logging)
    // while per-call middleware can fine-tune individual calls.
    const order: string[] = []
    const globalMw: Middleware = async (ctx, next) => {
      order.push('global')
      return next()
    }
    const requestMw: Middleware = async (ctx, next) => {
      order.push('request')
      return next()
    }
    const callMw: Middleware = async (ctx, next) => {
      order.push('call')
      return next()
    }

    const getItems = new Request<Record<string, never>, unknown>({
      method: 'GET',
      path: '/items',
      middleware: [requestMw]
    })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [globalMw] })

    mockJsonResponse([])
    await api.getItems({}, { middleware: [callMw] })

    expect(order).toEqual(['global', 'request', 'call'])
  })

  it('skips middleware via skipMiddleware', async () => {
    // The skipMiddleware option allows per-call exclusion of specific middleware.
    // Comparison is by reference identity (===), so the same function reference
    // must be passed to both the middleware array and the skipMiddleware array.
    const skipped: Middleware = async () => {
      throw new Error('should not run')
    }
    const kept: Middleware = async (_ctx, next) => next()

    const getItems = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [skipped, kept] })

    mockJsonResponse([])
    // Skip the first middleware — if it runs, the test will throw
    const { data } = await api.getItems({}, { skipMiddleware: [skipped] })

    expect(data).toEqual([])
  })
})
