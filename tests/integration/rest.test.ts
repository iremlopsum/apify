import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createApi } from '../../src/create-api.js'
import { Request } from '../../src/request.js'
import { retryMiddleware, cacheMiddleware, logMiddleware } from '../../src/built-in-middleware.js'
import { startServer, type TestServer } from './server.js'

let server: TestServer

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.close()
})

afterEach(() => {
  server.callCounts.clear()
})

describe('REST — core', () => {
  it('basic GET returns response data', async () => {
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { hello } })

    const { data, error } = await api.hello()

    expect(error).toBeNull()
    expect(data).toEqual({ message: 'hello' })
  })

  it('path params are substituted into the URL', async () => {
    const getUser = new Request<{ id: string }, { id: string; name: string }>({
      method: 'GET',
      path: '/users/:id',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { getUser } })

    const { data, error } = await api.getUser({ id: '42' })

    expect(error).toBeNull()
    expect(data).toEqual({ id: '42', name: 'User 42' })
  })

  it('GET params become query string, not request body', async () => {
    const search = new Request<{ q: string; page: string }, { params: Record<string, string> }>({
      method: 'GET',
      path: '/search',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { search } })

    const { data, error } = await api.search({ q: 'hello', page: '2' })

    expect(error).toBeNull()
    expect(data?.params).toEqual({ q: 'hello', page: '2' })
  })

  it('POST body is JSON-serialized with correct Content-Type', async () => {
    const echo = new Request<
      { name: string; age: number },
      { body: { name: string; age: number }; contentType: string }
    >({
      method: 'POST',
      path: '/echo',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { echo } })

    const { data, error } = await api.echo({ name: 'Alice', age: 30 })

    expect(error).toBeNull()
    expect(data?.body).toEqual({ name: 'Alice', age: 30 })
    expect(data?.contentType).toMatch(/^application\/json/)
  })

  it('headers from all three layers reach the server', async () => {
    const getHeaders = new Request<Record<string, never>, { headers: Record<string, string> }>({
      method: 'GET',
      path: '/headers',
      headers: { 'X-Per-Request': 'req-value' },
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { getHeaders },
      headers: { 'X-Global': 'global-value' },
    })

    const { data, error } = await api.getHeaders(
      {},
      { headers: { 'X-Per-Call': 'call-value' } },
    )

    // HTTP header names are lowercased in transit
    expect(error).toBeNull()
    expect(data?.headers['x-global']).toBe('global-value')
    expect(data?.headers['x-per-request']).toBe('req-value')
    expect(data?.headers['x-per-call']).toBe('call-value')
  })

  it('4xx response is returned as error Result — never thrown', async () => {
    const notFound = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/404',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { notFound } })

    const { data, error } = await api.notFound()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.status).toBe(404)
    // /status/404 sends no body at all — real server, real empty response.
    // This is the Critical 1 regression: the module-private empty-JSON
    // sentinel must never escape into error.body.
    expect(error?.body).toBeNull()
    expect(typeof error?.body).not.toBe('symbol')
  })
})

describe('retryMiddleware', () => {
  it('retries on 5xx and exhausts retry budget', async () => {
    const fail = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/503',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { fail },
      middleware: [retryMiddleware(2)],
    })

    const { data, error } = await api.fail()

    expect(data).toBeNull()
    expect(error?.status).toBe(503)
    // 1 initial attempt + 2 retries = 3 total real HTTP requests
    expect(server.callCounts.get('GET /status/503')).toBe(3)
  })

  it('retries until the server recovers from a transient 5xx', async () => {
    const flaky = new Request<Record<string, never>, { recovered: boolean }>({
      method: 'GET',
      path: '/flaky',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { flaky },
      middleware: [retryMiddleware(2)],
    })

    const { data, error } = await api.flaky()

    // Server returns 503 on calls 1 and 2 (count <= 2), then 200 on call 3
    expect(error).toBeNull()
    expect(data?.recovered).toBe(true)
    expect(server.callCounts.get('GET /flaky')).toBe(3)
  })

  it('does NOT retry 4xx responses', async () => {
    const bad = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/400',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { bad },
      middleware: [retryMiddleware(3)],
    })

    const { error } = await api.bad()

    expect(error?.status).toBe(400)
    // Only 1 attempt — 4xx is never retried regardless of maxRetries
    expect(server.callCounts.get('GET /status/400')).toBe(1)
  })
})

describe('cacheMiddleware', () => {
  it('second identical call is served from cache with no network request', async () => {
    const cache = cacheMiddleware({ ttl: 60_000 })
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { hello } })

    const first = await api.hello()
    const second = await api.hello()

    expect(first.data).toEqual({ message: 'hello' })
    expect(second.data).toEqual({ message: 'hello' })
    // Only one real HTTP request despite two calls
    expect(server.callCounts.get('GET /hello')).toBe(1)
  })

  it('clear() invalidates cache and forces a fresh network request', async () => {
    const cache = cacheMiddleware({ ttl: 60_000 })
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { hello } })

    await api.hello()
    cache.clear()
    await api.hello()

    expect(server.callCounts.get('GET /hello')).toBe(2)
  })

  it('error responses are not cached — next call hits the network again', async () => {
    const cache = cacheMiddleware({ ttl: 60_000 })
    const fail = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/500',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { fail } })

    await api.fail()
    await api.fail()

    // Both calls must reach the server — errors are never stored in cache
    expect(server.callCounts.get('GET /status/500')).toBe(2)
  })
})

describe('dedupe', () => {
  it('second concurrent call aborts the first and completes normally itself', async () => {
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
      dedupe: true,
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { hello } })

    // Both calls are dispatched synchronously. Registration happens at the top
    // of core(), so the first request has already reached fetch by the time the
    // second call's dedupeTracker.track() aborts its signal — it is cancelled
    // mid-flight and surfaces as a network error (status 0).
    const p1 = api.hello()
    const p2 = api.hello()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.error?.status).toBe(0)
    expect(r2.error).toBeNull()
    expect(r2.data).toEqual({ message: 'hello' })
  })
})

describe('logMiddleware', () => {
  it('logs request start and completion lines to console', async () => {
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { hello },
      middleware: [logMiddleware],
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await api.hello()

      expect(consoleSpy).toHaveBeenCalledTimes(2)
      // Format: "[apify] → GET hello http://127.0.0.1:PORT/hello"
      expect(consoleSpy.mock.calls[0][0]).toMatch(/\[apify\] → GET hello http:\/\/127\.0\.0\.1:\d+\/hello/)
      // Format: "[apify] ← hello OK (Xms)"
      expect(consoleSpy.mock.calls[1][0]).toMatch(/\[apify\] ← hello OK \(\d+ms\)/)
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

describe('onError', () => {
  it('fires onError on non-recovered error results', async () => {
    const onError = vi.fn()
    const fail = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/503',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { fail },
      onError,
    })

    await api.fail()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].status).toBe(503)
  })

  it('does NOT fire onError when retryMiddleware recovers a 5xx', async () => {
    const onError = vi.fn()
    const flaky = new Request<Record<string, never>, { recovered: boolean }>({
      method: 'GET',
      path: '/flaky',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { flaky },
      middleware: [retryMiddleware(2)],
      onError,
    })

    const { data, error } = await api.flaky()

    // Server fails on calls 1 and 2 (count<=2), recovers on call 3
    expect(error).toBeNull()
    expect(data?.recovered).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  // Round 3 review, Finding 1: parseResponse doesn't just parse — it
  // performs the network body read (response.text()/.blob()/etc.), so an
  // abort landing AFTER headers arrive (a component unmounting mid-download)
  // used to surface in the success-path `catch (parseErr)` block, which had
  // no provenance check: `kind: 'parse'`, `status: 200`, and — worse for
  // this describe block — reported to onError, mislabelling a user's own
  // cancellation as "the server responded but the body would not parse".
  // graphql.ts already got this right by accident of structure (its network
  // read is outside its own JSON.parse try); this is REST's real-server
  // reproduction of the same scenario, using a server that sends real
  // headers, a real partial body, then genuinely pauses — so the abort lands
  // while parseResponse's response.text() is actually in flight, not
  // simulated.
  it('does not report a real abort that lands mid-body-download as a parse failure', async () => {
    const onError = vi.fn()
    const slowBody = new Request<Record<string, never>, unknown>({
      method: 'GET',
      path: '/slow-body',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { slowBody }, onError })

    const ac = new AbortController()
    const p = api.slowBody(undefined, { signal: ac.signal })
    // Give the real headers (and the partial chunk) time to arrive before
    // aborting — the server's own completion is 2000ms out, well past this.
    await new Promise(resolve => setTimeout(resolve, 100))
    ac.abort()

    const { data, error, response } = await p
    expect(data).toBeNull()
    expect(error!.kind).toBe('abort')
    expect(response).toBeNull()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(onError).not.toHaveBeenCalled()
  })

  // Round 4 review, Finding 2: the !response.ok branch reads the error
  // body too (parseResponse again), and its catch swallowed EVERYTHING into
  // body: null with no provenance check — so an abort landing while an
  // error body downloads used to misreport as a genuine 'http' error
  // (status 503, body null) instead of the user's own cancellation. Same
  // user action as the 2xx test above; only the server's status code used
  // to decide which story the caller got.
  it('does not report a real abort that lands mid-error-body-download as an http error', async () => {
    const onError = vi.fn()
    const slowBodyError = new Request<Record<string, never>, unknown>({
      method: 'GET',
      path: '/slow-body-error',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { slowBodyError }, onError })

    const ac = new AbortController()
    const p = api.slowBodyError(undefined, { signal: ac.signal })
    await new Promise(resolve => setTimeout(resolve, 100))
    ac.abort()

    const { data, error, response } = await p
    expect(data).toBeNull()
    expect(error!.kind).toBe('abort')
    expect(response).toBeNull()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(onError).not.toHaveBeenCalled()
  })

  // Control, reworded (round 5 review, Finding M3): /slow-body-error writes
  // '{"partial":true,' then finishes with '"done":true}' -- the ASSEMBLED
  // body ('{"partial":true,"done":true}') is valid JSON, so parseResponse
  // succeeds here and the new abort-provenance catch above is never
  // entered at all; `error.body` is the parsed object, not null. This does
  // NOT exercise that catch's fallback branch (see
  // tests/parse-errors.test.ts's "classifies as http with a null body..."
  // for the test that actually pins kind: 'http' + body: null against a
  // genuinely unparseable body). What this control proves is narrower but
  // still real: the slow-but-uncancelled non-2xx path completes end to end
  // over a real connection -- real status, a real (parsed) body, classified
  // 'http', reported once -- unaffected by the new check that only
  // activates on an aborted signal.
  it('completes a slow (but uncancelled) non-2xx response normally, end to end', async () => {
    const onError = vi.fn()
    const slowBodyError = new Request<Record<string, never>, { partial: boolean; done: boolean }>({
      method: 'GET',
      path: '/slow-body-error',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { slowBodyError }, onError })

    const { data, error, response } = await api.slowBodyError()

    expect(data).toBeNull()
    expect(error!.kind).toBe('http')
    expect(error!.status).toBe(503)
    expect(error!.body).toEqual({ partial: true, done: true })
    expect(response).not.toBeNull()
    expect(response!.status).toBe(503)

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(onError).toHaveBeenCalledTimes(1)
  }, 5000)
})

describe('retry()', () => {
  it('result.retry() re-enters the full pipeline and returns a fresh result', async () => {
    const fail = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/503',
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { fail },
    })

    const first = await api.fail()

    expect(first.error?.status).toBe(503)
    expect(server.callCounts.get('GET /status/503')).toBe(1)

    const second = await first.retry()

    expect(second.error?.status).toBe(503)
    // retry() made a second real HTTP request — not a cached replay
    expect(server.callCounts.get('GET /status/503')).toBe(2)
  })
})

describe('baseUrl joining', () => {
  it('a trailing slash on baseUrl reaches the server as a single slash', async () => {
    // Every other test of this fix inspects the string the library builds.
    // This one asks the server what it actually received: callCounts is keyed
    // on the parsed pathname, so a doubled slash would register as '//hello'
    // and leave 'GET /hello' at zero.
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
    })
    const api = createApi({ baseUrl: `${server.baseUrl}/`, requests: { hello } })

    const { data, error } = await api.hello()

    expect(error).toBeNull()
    expect(data).toEqual({ message: 'hello' })
    expect(server.callCounts.get('GET /hello')).toBe(1)
    expect(server.callCounts.get('GET //hello')).toBeUndefined()
  })
})

describe("responseType 'none'", () => {
  it("responseType 'none' handles a real 204 end to end", async () => {
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: {
        del: new Request<Record<string, never>, undefined>({
          method: 'DELETE', path: '/no-content', responseType: 'none',
        }),
      },
    })
    const r = await api.del()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
    expect(r.response?.status).toBe(204)
  })

  it('a real 204 on a json request still warns and yields null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: {
        del: new Request<Record<string, never>, unknown>({ method: 'DELETE', path: '/no-content' }),
      },
    })
    const r = await api.del()
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
