import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

/** A fetch that never resolves unless its signal aborts. */
function hangingFetch() {
  return vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
    const s = init.signal as AbortSignal | undefined
    if (!s) { rej(new Error('no signal reached fetch')); return }
    if (s.aborted) { rej(s.reason); return }
    s.addEventListener('abort', () => rej(s.reason))
  }))
}

describe('timeout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('aborts the request and reports kind "timeout"', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const api = createApi({
      baseUrl: '',
      requests: { slow: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', timeout: 20 }) },
    })
    const r = await api.slow()
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('timeout')
    expect(r.error!.status).toBe(0)
  })

  it('does not affect a response that arrives in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":1}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      requests: { fast: new Request<Record<string, never>, { ok: number }>({ method: 'GET', path: '/fast', timeout: 1000 }) },
    })
    const r = await api.fast()
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: 1 })
  })

  it('lets a per-call timeout override the per-request one', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const api = createApi({
      baseUrl: '',
      requests: { slow: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', timeout: 10_000 }) },
    })
    const started = Date.now()
    const r = await api.slow({}, { timeout: 20 })
    expect(r.error!.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('treats 0 and omitted as no timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      requests: { z: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/z', timeout: 0 }) },
    })
    expect((await api.z()).error).toBeNull()
  })

  it('reports kind "abort", not "timeout", when the caller cancels first', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const api = createApi({
      baseUrl: '',
      requests: { slow: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', timeout: 5000 }) },
    })
    const ac = new AbortController()
    const p = api.slow({}, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.error!.kind).toBe('abort')
  })

  it('composes with dedupe rather than being discarded by it', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const api = createApi({
      baseUrl: '',
      requests: { s: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/s', dedupe: true, timeout: 20 }) },
    })
    const r = await api.s()
    expect(r.error!.kind).toBe('timeout')
  })

  it('gives retry() a fresh budget', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => { n++; return new Response('{"n":' + n + '}', { status: 200 }) }))
    const api = createApi({
      baseUrl: '',
      requests: { g: new Request<Record<string, never>, { n: number }>({ method: 'GET', path: '/g', timeout: 1000 }) },
    })
    const first = await api.g()
    const again = await first.retry()
    expect(again.error).toBeNull()
    expect(n).toBe(2)
  })
})
