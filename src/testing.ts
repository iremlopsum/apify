// =============================================================================
// testing.ts — framework-agnostic fetch mock for testing consumers of apify
// =============================================================================
//
// This is a separate entry point (`@iremlopsum/apify/testing`), not part of
// the core barrel. It gives consumers a `fetch` stub with route matching so
// they can exercise their own code against the real library pipeline — URL
// building, path substitution, header merging, body serialization, response
// parsing, and their own middleware — instead of re-deriving
// `vi.stubGlobal('fetch', ...)` boilerplate and getting the `Result` shape
// subtly wrong.
//
// Deliberately has zero test-runner dependency: `mock.fetch` is a plain
// function the consumer installs however their runner prefers. Mocking at the
// `fetch` boundary (rather than stubbing an api method to return a canned
// Result) is the point — a test that passes while a `path: '/users/:userId'`
// typo ships is not doing its job.
// =============================================================================

import { createSuccessResult, createErrorResult, ApiError } from './result.js'
import type { Result, SuccessResult, ErrorResult } from './types.js'

/** A JSON response with the right content-type, for use as a route value. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(body === null ? '' : JSON.stringify(body), { ...init, headers })
}

export interface RouteContext {
  params: Record<string, string>
  request: Request
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>
export type RouteValue = Response | RouteHandler | Array<Response | RouteHandler>

export interface RecordedCall {
  method: string
  url: string
  headers: Headers
  body: unknown
}

interface ParsedRoute {
  key: string
  method: string
  segments: string[]
  value: RouteValue
  cursor: number
}

/**
 * Matches one path against a route's segments, returning the captured
 * `:token` params or null. Split-and-compare rather than a regex, so there is
 * no lookbehind and no escaping question for keys containing metacharacters.
 */
function matchPath(routeSegments: string[], pathname: string): Record<string, string> | null {
  const actual = pathname.split('/').filter(Boolean)
  if (actual.length !== routeSegments.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < routeSegments.length; i++) {
    const expected = routeSegments[i]
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual[i])
    } else if (expected !== actual[i]) {
      return null
    }
  }
  return params
}

/**
 * A `fetch` stub that routes by `"METHOD /path"`, with `:token` capture.
 *
 * Stubs at the fetch boundary rather than the api boundary on purpose: URL
 * building, path substitution, header merging, body serialization, response
 * parsing and the consumer's own middleware all stay live. A test that passes
 * while a `path: '/users/:userId'` typo ships is not doing its job.
 *
 * Framework-agnostic — `fetch` is a plain function, so install it whichever
 * way your runner prefers.
 */
export function mockFetch(routes: Record<string, RouteValue>) {
  const parsed: ParsedRoute[] = Object.entries(routes).map(([key, value]) => {
    const spaceAt = key.indexOf(' ')
    if (spaceAt === -1) {
      // Fail loudly, in this module's usual style. Without this, indexOf
      // returns -1 and the slices silently produce method `key.slice(0, -1)`
      // ("/USER" for "/users") and a path from `key.slice(0)` — a route that
      // can never match anything, and a test that fails with "no route
      // matched" pointing at the request rather than at the typo'd key.
      throw new Error(
        `mockFetch: route key "${key}" must be "METHOD /path" — ` +
        `an HTTP method, a space, then the path (e.g. "GET /users/:id").`
      )
    }
    return {
      key,
      method: key.slice(0, spaceAt).toUpperCase(),
      segments: key.slice(spaceAt + 1).split('/').filter(Boolean),
      value,
      cursor: 0,
    }
  })

  const calls: RecordedCall[] = []
  const matchedKeys: string[] = []
  let previousFetch: typeof globalThis.fetch | undefined
  let installed = false

  const resolveValue = (route: ParsedRoute): Response | RouteHandler => {
    if (!Array.isArray(route.value)) return route.value
    if (route.value.length === 0) {
      // Fail loudly, in this module's usual style — an empty array would
      // otherwise fall through to `undefined.clone()` below and throw a bare
      // TypeError that sends the test author hunting in the wrong place.
      throw new Error(`mockFetch: route "${route.key}" has an empty response array.`)
    }
    // The final entry repeats once the sequence is exhausted.
    const index = Math.min(route.cursor, route.value.length - 1)
    route.cursor++
    return route.value[index]
  }

  const mockedFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]

    calls.push({
      method,
      url,
      headers: new Headers(init.headers),
      body: init.body ?? null,
    })

    for (const route of parsed) {
      if (route.method !== method) continue
      const params = matchPath(route.segments, pathname)
      if (!params) continue

      matchedKeys.push(route.key)
      const value = resolveValue(route)
      if (typeof value !== 'function') return value.clone()

      // The native `Request` constructor requires an absolute URL — browsers
      // resolve a relative one against the document, but Node's fetch has no
      // ambient base URL to resolve against and throws. `baseUrl: '/api'` is
      // the common case for this library, so fall back to a dummy origin for
      // construction only.
      const absoluteUrl = url.startsWith('http') ? url : new URL(url, 'http://localhost').href
      const request = new Request(absoluteUrl, init)
      // The dummy origin exists only so Node can parse a relative URL. Handlers
      // must observe the URL the caller actually used, and the same string
      // `calls[]` records — otherwise an assertion on request.url silently
      // checks a fabricated host.
      Object.defineProperty(request, 'url', { get: () => url })
      return value({ params, request })
    }

    // Fail loudly. Returning a 404 would look like a server behaviour rather
    // than a missing stub, and would send the test author hunting in the
    // wrong place.
    matchedKeys.push('')
    throw new Error(
      `mockFetch: no route matched ${method} ${url}. ` +
      `Defined routes: ${parsed.map(r => r.key).join(', ') || '(none)'}`
    )
  }

  return {
    fetch: mockedFetch as unknown as typeof globalThis.fetch,
    calls,
    callCount: (key: string): number => matchedKeys.filter(k => k === key).length,
    lastCall: (key: string): RecordedCall | undefined => {
      for (let i = matchedKeys.length - 1; i >= 0; i--) {
        if (matchedKeys[i] === key) return calls[i]
      }
      return undefined
    },
    install(): void {
      // A second install would capture the mock itself as "previous" and lose
      // the real fetch for good, so installing twice is a no-op.
      if (installed) return
      previousFetch = globalThis.fetch
      installed = true
      globalThis.fetch = mockedFetch as unknown as typeof globalThis.fetch
    },
    restore(): void {
      // Restoring without a matching install would clobber whatever is there
      // now with a stale value we never owned.
      if (!installed) return
      globalThis.fetch = previousFetch as typeof globalThis.fetch
      installed = false
    },
  }
}

// The `SuccessResult<T>` / `ErrorResult<T>` locals below (rather than `Result<T>`)
// are what make a future `Result` change fail loudly here — that's enforced by
// `npm run typecheck` (tsc over src/), not by tests/types.test-d.ts, which
// asserts the public `Result<T>` contract these builders still expose.

/**
 * A success `Result`, for consumers stubbing at the api level.
 *
 * Worth using rather than hand-rolling `{ data, error: null, ... }`: 3.0.0
 * turns `Result` into a discriminated union where `response` is non-null on
 * success, so a hand-rolled literal breaks on that upgrade and this does not.
 */
export function successResult<T>(data: T, init: ResponseInit = {}): Result<T> {
  const result: SuccessResult<T> = createSuccessResult(data, jsonResponse(data, init), async () => result)
  return result
}

/** An error `Result` with the given HTTP status. */
export function errorResult<T>(status: number, body: unknown = null): Result<T> {
  const error = new ApiError({
    kind: 'http',
    status,
    statusText: '',
    body,
    headers: new Headers(),
    request: { method: 'GET', url: '', params: {} },
  })
  const result: ErrorResult<T> = createErrorResult<T>(error, jsonResponse(body, { status }), async () => result)
  return result
}
