import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { abortKind } from '../src/utils/is-abort-error.js'

const api = (extra = {}) => createApi({
  baseUrl: '',
  requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g', ...extra }) },
})

describe('abortKind', () => {
  it('classifies by name, not by class', () => {
    expect(abortKind(new DOMException('x', 'AbortError'))).toBe('abort')
    expect(abortKind(new DOMException('x', 'TimeoutError'))).toBe('timeout')
    expect(abortKind({ name: 'AbortError' })).toBe('abort')
    expect(abortKind(new TypeError('fetch failed'))).toBeNull()
    expect(abortKind(null)).toBeNull()
    expect(abortKind('AbortError')).toBeNull()
  })
})

describe('ApiError.kind', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is "http" for a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })))
    const r = await api().g()
    expect(r.error?.kind).toBe('http')
  })

  it('is "network" when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const r = await api().g()
    expect(r.error?.kind).toBe('network')
  })

  it('is "abort" when the caller aborts', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      const s = init.signal as AbortSignal
      s.addEventListener('abort', () => rej(s.reason))
    })))
    const ac = new AbortController()
    const p = api().g({}, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.error?.kind).toBe('abort')
  })

  it('is "abort" when dedupe supersedes a request', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((res, rej) => {
      const s = init.signal as AbortSignal | undefined
      s?.addEventListener('abort', () => rej(s.reason))
      setTimeout(() => res(new Response('{}', { status: 200 })), 50)
    })))
    const client = api({ dedupe: true })
    const first = client.g()
    const second = client.g()
    expect((await first).error?.kind).toBe('abort')
    await second
  })

  it('is "network" for a synchronous setup failure', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const bad = createApi({
      baseUrl: '',
      requests: { q: new Request<{ nested: object }, unknown>({ method: 'GET', path: '/q' }) },
    })
    const r = await bad.q({ nested: { a: 1 } })
    expect(r.error?.kind).toBe('network')
  })
})
