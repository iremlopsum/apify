import { describe, it, expect, vi, afterEach } from 'vitest'
import { mockFetch, jsonResponse } from '../src/testing.js'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

const api = () => createApi({
  baseUrl: '/api',
  requests: {
    getUser: new Request<{ id: string }, { id: string; name: string }>({ method: 'GET', path: '/users/:id' }),
    createUser: new Request<{ name: string }, { id: string }>({ method: 'POST', path: '/users' }),
    flaky: new Request<Record<string, never>, { ok: boolean }>({ method: 'GET', path: '/flaky' }),
  },
})

describe('mockFetch', () => {
  afterEach(() => vi.restoreAllMocks())

  it('matches a route with a :token and exposes the params', async () => {
    const mock = mockFetch({ 'GET /api/users/:id': ({ params }) => jsonResponse({ id: params.id, name: 'Ada' }) })
    vi.stubGlobal('fetch', mock.fetch)
    const r = await api().getUser({ id: '42' })
    expect(r.data).toEqual({ id: '42', name: 'Ada' })
  })

  it('discriminates by method', async () => {
    const mock = mockFetch({
      'GET /api/users/:id': jsonResponse({ id: 'g', name: 'get' }),
      'POST /api/users': jsonResponse({ id: 'p' }, { status: 201 }),
    })
    vi.stubGlobal('fetch', mock.fetch)
    expect((await api().createUser({ name: 'x' })).data).toEqual({ id: 'p' })
  })

  it('advances through a response sequence', async () => {
    const mock = mockFetch({
      'GET /api/flaky': [jsonResponse(null, { status: 503 }), jsonResponse({ ok: true })],
    })
    vi.stubGlobal('fetch', mock.fetch)
    const client = api()
    expect((await client.flaky()).error?.status).toBe(503)
    expect((await client.flaky()).data).toEqual({ ok: true })
  })

  it('fails loudly on an unmatched route', async () => {
    const mock = mockFetch({ 'GET /api/users/:id': jsonResponse({ id: '1', name: 'a' }) })
    vi.stubGlobal('fetch', mock.fetch)
    const r = await api().createUser({ name: 'x' })
    expect(String(r.error?.body)).toMatch(/POST/)
  })

  it('records calls, counts and the last call', async () => {
    const mock = mockFetch({ 'GET /api/users/:id': jsonResponse({ id: '1', name: 'a' }) })
    vi.stubGlobal('fetch', mock.fetch)
    const client = api()
    await client.getUser({ id: '1' })
    await client.getUser({ id: '2' })
    expect(mock.calls.length).toBe(2)
    expect(mock.callCount('GET /api/users/:id')).toBe(2)
    expect(mock.lastCall('GET /api/users/:id')?.url).toContain('/users/2')
  })

  it('restores globalThis.fetch exactly', () => {
    const original = globalThis.fetch
    const mock = mockFetch({})
    mock.install()
    expect(globalThis.fetch).toBe(mock.fetch)
    mock.restore()
    expect(globalThis.fetch).toBe(original)
  })

  it("hands the handler the caller's real relative URL, not the dummy origin used to parse it", async () => {
    let seenUrl = ''
    const mock = mockFetch({
      'GET /api/users/:id': ({ params, request }) => {
        seenUrl = request.url
        return jsonResponse({ id: params.id, name: 'Ada' })
      },
    })
    vi.stubGlobal('fetch', mock.fetch)
    await api().getUser({ id: '42' })
    expect(seenUrl).toBe(mock.calls[0].url)
    expect(seenUrl).toBe('/api/users/42')
  })

  it('is idempotent: a second install() does not lose the real fetch', () => {
    const original = globalThis.fetch
    const mock = mockFetch({})
    mock.install()
    mock.install()
    mock.restore()
    expect(globalThis.fetch).toBe(original)
  })

  it('restore() with no prior install() leaves globalThis.fetch untouched', () => {
    const original = globalThis.fetch
    const mock = mockFetch({})
    mock.restore()
    expect(globalThis.fetch).toBe(original)
  })

  it('throws a descriptive error for an empty response array rather than a bare TypeError', async () => {
    const mock = mockFetch({ 'GET /api/flaky': [] })
    vi.stubGlobal('fetch', mock.fetch)
    const r = await api().flaky()
    expect(String(r.error?.body)).toMatch(/empty response array/)
  })
  it('rejects a route key that has no method', () => {
    // Without the check, indexOf(' ') returns -1 and the method silently
    // becomes the key minus its last character ("/USER" for "/users"), so the
    // route can never match and the failure points at the request instead of
    // at the typo'd key.
    expect(() => mockFetch({ '/users': jsonResponse({}) })).toThrow(/METHOD \/path/)
  })
})

// ---------------------------------------------------------------------------
// mockFetch honours init.signal, as real fetch does (4.4.2)
//
// Before, a stalled route could not be aborted: the stub never looked at the
// signal, so a consumer could not test their own timeout or cancellation
// handling through it. It now rejects with `signal.reason` — the exact value
// real fetch rejects with — both for a signal that is already aborted and for
// one that aborts while a handler is still pending.
// ---------------------------------------------------------------------------
describe('mockFetch and init.signal', () => {
  afterEach(() => vi.restoreAllMocks())

  const stalled = () => new Promise<Response>(() => {})

  it('rejects with signal.reason when the signal aborts while a handler is pending', async () => {
    const mock = mockFetch({ 'GET /slow': stalled })
    const ac = new AbortController()
    const reason = new Error('gave up')
    const p = mock.fetch('/slow', { signal: ac.signal })
    ac.abort(reason)
    const outcome = await Promise.race([
      p.then(() => 'resolved', (e: unknown) => e),
      new Promise(r => setTimeout(() => r('still pending'), 500)),
    ])
    expect(outcome).toBe(reason)
  })

  it('rejects with signal.reason for a signal that is already aborted, for a Response route too', async () => {
    const mock = mockFetch({ 'GET /fast': jsonResponse({ ok: true }) })
    const signal = AbortSignal.abort()
    await expect(mock.fetch('/fast', { signal })).rejects.toBe(signal.reason)
    expect(mock.callCount('GET /fast')).toBe(1) // still recorded
    expect(mock.lastCall('GET /fast')?.url).toBe('/fast')
  })

  it('does not consume a sequenced response for an aborted call', async () => {
    const mock = mockFetch({ 'GET /seq': [jsonResponse({ n: 1 }), jsonResponse({ n: 2 })] })
    await expect(mock.fetch('/seq', { signal: AbortSignal.abort() })).rejects.toBeDefined()
    expect(await (await mock.fetch('/seq')).json()).toEqual({ n: 1 })
  })

  it('lets a consumer test their own timeout through the stub', async () => {
    const mock = mockFetch({ 'GET /api/users/:id': stalled })
    vi.stubGlobal('fetch', mock.fetch)
    // The library's backstop would settle the call either way. What only an
    // abortable stub delivers is the timeout coming back through the chain,
    // so a consumer's middleware sees it from next() as it would in production.
    const seen: (string | undefined)[] = []
    const client = createApi({
      baseUrl: '/api',
      middleware: [async (_ctx, next) => { const r = await next(); seen.push(r.error?.kind); return r }],
      requests: { getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id' }) },
    })
    const r = await client.getUser({ id: '1' }, { timeout: 20 })
    expect(r.error?.kind).toBe('timeout')
    expect(seen).toEqual(['timeout'])
  })

  it('removes its abort listener once a handler settles', async () => {
    const mock = mockFetch({ 'GET /ok': () => Promise.resolve(jsonResponse({ ok: true })) })
    const ac = new AbortController()
    // The stub builds a native Request for the handler, and a native Request
    // follows its signal by itself (as real fetch does internally). Measure
    // what one of those adds, so only the stub's own listener is counted.
    const probe = new AbortController()
    let perRequest = 0
    const probeAdd = probe.signal.addEventListener.bind(probe.signal)
    probe.signal.addEventListener = ((...a: Parameters<AbortSignal['addEventListener']>) => { perRequest++; probeAdd(...a) }) as AbortSignal['addEventListener']
    void new globalThis.Request('http://localhost/ok', { signal: probe.signal })
    let live = 0
    const add = ac.signal.addEventListener.bind(ac.signal)
    const remove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((...a: Parameters<AbortSignal['addEventListener']>) => { live++; add(...a) }) as AbortSignal['addEventListener']
    ac.signal.removeEventListener = ((...a: Parameters<AbortSignal['removeEventListener']>) => { live--; remove(...a) }) as AbortSignal['removeEventListener']
    for (let i = 0; i < 3; i++) expect((await mock.fetch('/ok', { signal: ac.signal })).ok).toBe(true)
    expect(live).toBe(3 * perRequest)
  })

  it('still resolves normally with no signal at all', async () => {
    const mock = mockFetch({ 'GET /ok': () => jsonResponse({ ok: true }) })
    expect((await mock.fetch('/ok')).ok).toBe(true)
  })
})
