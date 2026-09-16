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

describe('empty JSON body — 3.1.0 behaviour', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('still resolves as a success with data null', async () => {
    empty()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await jsonApi().a()
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
  })

  it('warns once across repeated calls to the same request', async () => {
    empty()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = jsonApi()
    await api.a(); await api.a(); await api.a()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('a')
    expect(String(warn.mock.calls[0][0])).toContain("responseType: 'none'")
  })

  it('warns separately for different request names', async () => {
    empty()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = jsonApi()
    await api.a(); await api.b()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('warns independently per createApi instance', async () => {
    empty()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await jsonApi().a()
    await jsonApi().a()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("is silent for responseType 'none'", async () => {
    empty()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await jsonApi().none()
    expect(r.data).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is silent for a literal null body, which is valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await jsonApi().a()
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not fail the request when console.warn itself throws', async () => {
    empty()
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console is broken') })
    const r = await jsonApi().a()
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
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

  it('does not warn for an empty error body — the warning is success-path only', async () => {
    emptyError(404)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await jsonApi().a()
    expect(warn).not.toHaveBeenCalled()
  })
})
