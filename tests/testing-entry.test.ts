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
})
