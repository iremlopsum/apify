import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

const api = () => createApi({
  baseUrl: '',
  requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
})

describe('malformed body on a successful response', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('<html>oops</html>', { status: 200, statusText: 'OK' }))))
  afterEach(() => vi.restoreAllMocks())

  it('reports kind "parse", not a network error', async () => {
    expect((await api().g()).error?.kind).toBe('parse')
  })

  it('keeps the real HTTP status', async () => {
    expect((await api().g()).error?.status).toBe(200)
  })

  it('keeps the Response so headers stay reachable', async () => {
    const r = await api().g()
    expect(r.response).not.toBeNull()
    expect(r.response!.status).toBe(200)
  })

  it('puts the SyntaxError in body', async () => {
    expect(String((await api().g()).error?.body)).toContain('JSON')
  })
})

describe('a genuine network failure is still kind "network"', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') })))
  afterEach(() => vi.restoreAllMocks())

  it('keeps status 0 and a null response', async () => {
    const r = await api().g()
    expect(r.error?.kind).toBe('network')
    expect(r.error?.status).toBe(0)
    expect(r.response).toBeNull()
  })
})

describe('a parse failure on a 5xx is retryable', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('not json', { status: 503, statusText: 'Service Unavailable' }))))
  afterEach(() => vi.restoreAllMocks())

  it('retryMiddleware sees the real status and retries', async () => {
    const { retryMiddleware } = await import('../src/built-in-middleware.js')
    const a = createApi({
      baseUrl: '', middleware: [retryMiddleware({ max: 2, baseDelay: 1 })],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    await a.g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })
})
