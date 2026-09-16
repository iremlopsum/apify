import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

const jsonApi = () => createApi({
  baseUrl: '',
  requests: {
    a: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/a' }),
    b: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/b' }),
    none: new Request<Record<string, never>, undefined>({
      method: 'GET', path: '/n', responseType: 'none',
    }),
  },
})

const empty = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))

describe('empty JSON body — 4.0.0 rule', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it("reports a kind 'parse' error instead of resolving with data null", async () => {
    empty()
    const r = await jsonApi().a()
    expect(r.error?.kind).toBe('parse')
    expect(r.data).toBeNull()
  })

  it('keeps the real status and the Response — the server DID answer', async () => {
    empty()
    const r = await jsonApi().a()
    expect(r.error?.status).toBe(200)
    expect(r.error?.statusText).toBe('')
    expect(r.response).not.toBeNull()
    expect(r.response?.status).toBe(200)
  })

  it('reports the real status for a 204, with no special case', async () => {
    // Section 1 of the spec: one rule — declared JSON, got no JSON — rather
    // than status-dependent behaviour. A 204 is not privileged here; the
    // endpoint that legitimately answers 204 declares responseType: 'none'.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const r = await jsonApi().a()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.status).toBe(204)
  })

  it('carries the raw response text as error.body', async () => {
    // There is no exception to report here — unlike every other 'parse'
    // error, nothing threw. The raw text is the honest answer to "then what
    // did the server send?", and for this branch it is always ''.
    empty()
    const r = await jsonApi().a()
    expect(r.error?.body).toBe('')
  })

  it('no longer warns — the 3.1.0 diagnostic is gone', async () => {
    empty()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = jsonApi()
    await api.a(); await api.a(); await api.b()
    expect(warn).not.toHaveBeenCalled()
  })

  it('still succeeds for a literal null body, which is valid JSON', async () => {
    // The whole reason EMPTY_JSON_BODY is a Symbol rather than a null check:
    // JSON.parse("null") is null, and a server sending the body `null` sent
    // valid JSON. Erroring on it would break correct responses.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    const r = await jsonApi().a()
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
  })

  it("leaves responseType 'none' a success — it is the documented fix", async () => {
    empty()
    const r = await jsonApi().none()
    expect(r.error).toBeNull()
    expect(r.data).toBeUndefined()
  })

  it('still offers retry() on the parse error', async () => {
    empty()
    const r = await jsonApi().a()
    expect(typeof r.retry).toBe('function')
  })
})

// -----------------------------------------------------------------------------
// Critical 1: the empty-JSON sentinel escaping into `error.body` on a non-2xx
// response. `parseResponse`'s `json` branch returns the module-private
// EMPTY_JSON_BODY symbol for an empty body; the success path normalizes it
// to `null`, but the `!response.ok` call site originally did not, so the
// symbol reached `ApiError.body` directly. Silent to the type checker
// (`body` is `unknown`), and it breaks the "never throws" contract for any
// consumer that does `` `${error.body}` `` in their own error handler.
// -----------------------------------------------------------------------------
const emptyError = (status: number) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))

describe('empty JSON body on a non-2xx response', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it("normalizes to null for an empty 404 with responseType 'json'", async () => {
    emptyError(404)
    const r = await jsonApi().a()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.status).toBe(404)
    expect(r.error?.body).toBeNull()
    expect(typeof r.error?.body).not.toBe('symbol')
  })

  it("normalizes to null for an empty error body with responseType 'none'", async () => {
    emptyError(404)
    const r = await jsonApi().none()
    expect(r.error?.body).toBeNull()
  })

  it('does not throw when a consumer template-literals error.body', async () => {
    emptyError(404)
    const r = await jsonApi().a()
    expect(() => `${r.error?.body}`).not.toThrow()
    expect(`${r.error?.body}`).toBe('null')
  })
})
