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

    // Both calls are dispatched synchronously. The second call's dedupeTracker.track()
    // aborts the first signal before fetch is even called, so the first request
    // immediately fails with a network error (status 0).
    const p1 = api.hello()
    const p2 = api.hello()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.error?.status).toBe(0)
    expect(r2.error).toBeNull()
    expect(r2.data).toEqual({ message: 'hello' })
    // Aborted request never reached the server — only 1 real HTTP call
    expect(server.callCounts.get('GET /hello')).toBe(1)
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
