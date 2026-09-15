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

  // Boundary check, not a fix discriminator: the SyntaxError lands in `body`
  // regardless of which catch block captures it, so this passes identically
  // before and after the fix. It documents that `body` still carries the
  // native parse error once routing is corrected.
  it('puts the SyntaxError in body', async () => {
    expect(String((await api().g()).error?.body)).toContain('JSON')
  })
})

// Boundary check, not a fix discriminator: this exercises the fetch-throw
// (network) path, which the parse-routing fix never touches. It passes
// identically before and after, and exists to pin that a genuine network
// failure is not accidentally reclassified as 'parse'.
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

// Non-regression check, not a fix discriminator: `!response.ok` is evaluated
// before the new parse try/catch, so no 4xx/5xx can ever reach it -- a 5xx
// with an unparseable body already took the http path (kind 'http') before
// this task, and still does. This test passes identically before and after
// the fix; it exists to catch a *future* refactor (e.g. merging the http and
// success parse try/catches) that inverts or collapses that branch order.
describe('a 5xx with an unparseable body is unaffected by this task', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('not json', { status: 503, statusText: 'Service Unavailable' }))))
  afterEach(() => vi.restoreAllMocks())

  it('retryMiddleware already saw the real status and retried -- ordering unchanged', async () => {
    const { retryMiddleware } = await import('../src/built-in-middleware.js')
    const a = createApi({
      baseUrl: '', middleware: [retryMiddleware({ max: 2, baseDelay: 1 })],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    await a.g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })
})
