import { describe, it, expect, vi, afterEach } from 'vitest'
import { CacheStore, stableStringify } from '../src/utils/cache.js'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { cacheMiddleware } from '../src/built-in-middleware.js'

afterEach(() => vi.restoreAllMocks())

function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe('stableStringify', () => {
  it('returns null for null', () => {
    expect(stableStringify(null)).toBe('null')
  })

  it('returns [undefined] for undefined', () => {
    expect(stableStringify(undefined)).toBe('[undefined]')
  })

  it('distinguishes null and undefined in objects', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({ a: undefined }))
  })

  it('sorts object keys alphabetically', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('sorts nested object keys', () => {
    expect(stableStringify({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}')
  })

  it('escapes special characters in object keys', () => {
    expect(stableStringify({ 'a"b': 1 })).toBe('{"a\\"b":1}')
  })

  it('preserves array element order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles number primitives', () => {
    expect(stableStringify(42)).toBe('42')
  })

  it('handles string primitives with quoting', () => {
    expect(stableStringify('hello')).toBe('"hello"')
  })

  it('handles boolean primitives', () => {
    expect(stableStringify(true)).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

describe('CacheStore', () => {
  it('returns null for an unknown key', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    expect(store.get('missing')).toBeNull()
  })

  it('returns a stored value within TTL', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('key', { name: 'Alice' })
    expect(store.get('key')).toEqual({ name: 'Alice' })
  })

  it('returns null after TTL expires and deletes the entry', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 1000, maxSize: 10 })
    store.set('key', 'value')
    dateSpy.mockReturnValue(1001) // past TTL
    expect(store.get('key')).toBeNull()
    // confirm the entry was removed (not merely skipped)
    dateSpy.mockReturnValue(500) // back inside what would have been TTL
    expect(store.get('key')).toBeNull()
  })

  it('returns null exactly at TTL boundary', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 1000, maxSize: 10 })
    store.set('key', 'value')
    dateSpy.mockReturnValue(1000) // exactly at TTL
    expect(store.get('key')).toBeNull()
  })

  it('clears all entries', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('a', 1)
    store.set('b', 2)
    store.clear()
    expect(store.get('a')).toBeNull()
    expect(store.get('b')).toBeNull()
  })

  it('evicts the oldest entry when maxSize is reached', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 60_000, maxSize: 2 })
    store.set('a', 'first')   // timestamp 0 — oldest
    dateSpy.mockReturnValue(1)
    store.set('b', 'second')  // timestamp 1
    dateSpy.mockReturnValue(2)
    store.set('c', 'third')   // triggers eviction of 'a'
    expect(store.get('a')).toBeNull()    // evicted
    expect(store.get('b')).toBe('second')
    expect(store.get('c')).toBe('third')
  })
})

// ---------------------------------------------------------------------------
// cacheMiddleware
// ---------------------------------------------------------------------------

describe('cacheMiddleware', () => {
  it('returns cached result on second call without hitting network', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      return mockJsonResponse({ name: 'Alice' })
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    const first = await api.getUser({ id: '1' })
    const second = await api.getUser({ id: '1' })

    expect(callCount).toBe(1)
    expect(second.data).toEqual({ name: 'Alice' })
    expect(second.error).toBeNull()
  })

  it('fetches independently for different params', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '2' })

    expect(callCount).toBe(2)
  })

  it('fetches again after TTL expires', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)

    const cache = cacheMiddleware({ ttl: 1000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    dateSpy.mockReturnValue(1001)
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('does not cache error responses', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      return new Response(null, { status: 404 })
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('does not cache network errors', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      throw new TypeError('Failed to fetch')
    })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('evicts oldest entry when maxSize is reached', async () => {
    const dateSpy = vi.spyOn(Date, 'now')
    let t = 0
    dateSpy.mockImplementation(() => t++)

    const responses: Record<string, string> = { '1': 'Alice', '2': 'Bob', '3': 'Carol' }
    vi.stubGlobal('fetch', async (url: string) => {
      const id = String(url).split('/').pop()!
      return mockJsonResponse({ name: responses[id] })
    })

    // maxSize: 2 — stores up to 2 entries; adding a 3rd evicts the oldest (id '1')
    const cache = cacheMiddleware({ ttl: 60_000, maxSize: 2 })
    const getUser = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    // Phase 1: fill cache; id '1' is the oldest and gets evicted when id '3' is stored
    await api.getUser({ id: '1' }) // stored — oldest
    await api.getUser({ id: '2' }) // stored
    await api.getUser({ id: '3' }) // triggers eviction of id '1'; store = {'2','3'}

    // Phase 2: replace fetch stub; count new network calls
    let fetchCount = 0
    vi.stubGlobal('fetch', async () => { fetchCount++; return mockJsonResponse({ name: 'refetched' }) })

    // id '2' and '3' are still cached — no fetches needed
    await api.getUser({ id: '2' })
    await api.getUser({ id: '3' })
    expect(fetchCount).toBe(0)

    // id '1' was evicted — must fetch
    await api.getUser({ id: '1' })
    expect(fetchCount).toBe(1)
  })

  it('clears all entries and fetches again', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    cache.clear()
    await api.getUser({ id: '1' })

    expect(callCount).toBe(2)
  })

  it('logs HIT and MISS to console when debug is true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => mockJsonResponse({}))
    const cache = cacheMiddleware({ ttl: 60_000, debug: true })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' }) // MISS
    await api.getUser({ id: '1' }) // HIT

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('[apify cache] MISS'))
    expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('[apify cache] HIT'))
  })

  it('does not log when debug is omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => mockJsonResponse({}))
    const cache = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { getUser } })

    await api.getUser({ id: '1' })
    await api.getUser({ id: '1' })

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('treats params with different key order as the same cache entry', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cache = cacheMiddleware({ ttl: 60_000 })
    const search = new Request<{ q: string; page: number }, unknown>({
      method: 'GET',
      path: '/search',
      middleware: [cache],
    })
    const api = createApi({ baseUrl: '', requests: { search } })

    await api.search({ q: 'hello', page: 1 })
    const altOrderParams: { q: string; page: number } = { page: 1, q: 'hello' }
    await api.search(altOrderParams)

    expect(callCount).toBe(1)
  })

  it('two separate instances never share cache entries', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => { callCount++; return mockJsonResponse({}) })
    const cacheA = cacheMiddleware({ ttl: 60_000 })
    const cacheB = cacheMiddleware({ ttl: 60_000 })
    const getUser = new Request<{ id: string }, unknown>({
      method: 'GET',
      path: '/users/:id',
    })
    const apiA = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheA] })
    const apiB = createApi({ baseUrl: '', requests: { getUser }, middleware: [cacheB] })

    await apiA.getUser({ id: '1' })
    await apiB.getUser({ id: '1' }) // different store — must fetch

    expect(callCount).toBe(2)
  })
  // ---------------------------------------------------------------------------
  // docs/FIXES.md #14: stableStringify collapses FormData, Blob, ArrayBuffer
  // and URLSearchParams to the literal string "{}" — it falls through to
  // Object.keys() for any object, and Object.keys() returns [] for all of them
  // regardless of content. Two different uploads through one cache therefore
  // produced the identical key and served each other's responses. `share` was
  // given a guard against this exact collapse in 2.2.0; the cache had none.
  // ---------------------------------------------------------------------------
  it('never serves one special-body payload the response to another', async () => {
    const bodies = ['A', 'B']
    let n = 0
    const fetchMock = vi.fn(async () => mockJsonResponse({ who: bodies[n++] }))
    vi.stubGlobal('fetch', fetchMock)

    const cache = cacheMiddleware({ ttl: 60_000 })
    const api = createApi({
      baseUrl: '',
      requests: {
        upload: new Request<FormData, { who: string }>({ method: 'POST', path: '/upload', middleware: [cache] }),
      },
    })

    const a = new FormData(); a.append('payload', 'SECRET-A')
    const b = new FormData(); b.append('payload', 'SECRET-B')

    const rA = await api.upload(a)
    const rB = await api.upload(b)

    expect(fetchMock.mock.calls.length).toBe(2)   // B must reach the network
    expect(rA.data).toEqual({ who: 'A' })
    expect(rB.data).toEqual({ who: 'B' })         // never A's cached response
  })

  it('declines to cache special-body params at all, rather than keying them wrongly', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const cache = cacheMiddleware({ ttl: 60_000 })
    const api = createApi({
      baseUrl: '',
      requests: {
        submit: new Request<URLSearchParams, { ok: boolean }>({ method: 'POST', path: '/submit', middleware: [cache] }),
      },
    })

    // The same params twice: still two real requests. Declining to cache is
    // always safe; serving the wrong response never is.
    await api.submit(new URLSearchParams({ q: 'x' }))
    await api.submit(new URLSearchParams({ q: 'x' }))

    expect(fetchMock.mock.calls.length).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Fix 3 (2.2.1): the guard added for docs/FIXES.md #14 reused isSpecialBody,
  // which also excludes a raw `string` — but stableStringify keys a string
  // correctly (via JSON.stringify), so a string-param endpoint is soundly
  // cacheable. Sharing the predicate with isSpecialBody silently disabled
  // caching for every string-param endpoint in 2.2.0. isOpaqueParams (the
  // four object types only) fixes this without reopening #14: FormData, Blob,
  // ArrayBuffer and URLSearchParams must still decline to cache.
  // ---------------------------------------------------------------------------
  it('caches a string-param endpoint (a raw string is soundly keyable, unlike FormData/Blob/etc)', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const cache = cacheMiddleware({ ttl: 60_000 })
    // `Request<TParams extends object, ...>` cannot name `string` itself —
    // a raw string body is a runtime-only concept (isSpecialBody/isOpaqueParams
    // both operate on the erased `object` params createApi actually passes
    // through), so the call site casts past the declared (but here vacuous)
    // `Record<string, never>` params type to exercise it, the same way the
    // suite already casts a BigInt timeout past `number` elsewhere.
    const api = createApi({
      baseUrl: '',
      requests: {
        search: new Request<Record<string, never>, { ok: boolean }>({ method: 'POST', path: '/search', middleware: [cache] }),
      },
    })

    await api.search('needle' as unknown as Record<string, never>)
    await api.search('needle' as unknown as Record<string, never>)

    expect(fetchMock.mock.calls.length).toBe(1) // second call is a cache hit
  })
})
