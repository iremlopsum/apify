import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

const api = () => createApi({
  baseUrl: '',
  requests: {
    del: new Request<Record<string, never>, undefined>({
      method: 'DELETE', path: '/u', responseType: 'none',
    }),
  },
})

describe("responseType: 'none'", () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('yields undefined data and no error for a 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const r = await api().del()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
    expect(r.response?.status).toBe(204)
  })

  it('yields undefined for an empty 200 too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const r = await api().del()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
  })

  it('discards a body the server sends anyway, without erroring', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ignored":true}', { status: 200 })))
    const r = await api().del()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
  })

  it('still reports a non-2xx as an http error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const r = await api().del()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.status).toBe(500)
  })

  it('still reads a JSON error body on a non-2xx, even though success has none', async () => {
    // 'none' describes the success shape only. An error body is diagnostic
    // (a message, a code) and is worth reading even when the caller wants
    // nothing back on success — this is the pin for that.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'already deleted' }), { status: 409 })
    ))
    const r = await api().del()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.status).toBe(409)
    expect(r.error?.body).toEqual({ error: 'already deleted' })
  })

  it('degrades a non-JSON error body to null instead of throwing', async () => {
    // An HTML error page (e.g. from a gateway) is not valid JSON. The
    // pre-existing parse-failure fallback (body = null) must still apply
    // for a 'none' request's error path, exactly as it does for any other
    // responseType.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html><body>Server Error</body></html>', { status: 500 })
    ))
    const r = await api().del()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.status).toBe(500)
    expect(r.error?.body).toBeNull()
  })

  it('does not throw when the body stream cannot be cancelled', async () => {
    // A Response whose body getter throws — the shape a hostile or exotic
    // polyfill can produce. Cancelling is cleanup; it must never fail a request.
    vi.stubGlobal('fetch', vi.fn(async () => {
      // NOTE: brief specified `new Response('', { status: 204 })` here, but
      // Node's fetch implementation enforces the Fetch spec's null-body-status
      // rule strictly and throws `TypeError: Response constructor: Invalid
      // response status code 204` when the body is an empty string (only
      // `null` is accepted for a 204). Using `null` preserves the test's
      // intent (a 204 with a body getter that throws) without hitting that
      // unrelated construction failure.
      const res = new Response(null, { status: 204 })
      Object.defineProperty(res, 'body', { get() { throw new Error('no body for you') } })
      return res
    }))
    const r = await api().del()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
  })
})
