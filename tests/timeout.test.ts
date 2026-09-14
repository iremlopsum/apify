import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

/** A fetch that resolves after `ms`, or rejects if its signal aborts first. */
function delayedFetch(ms: number) {
  return vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const s = init.signal as AbortSignal | undefined
    const timer = setTimeout(() => res(new Response('{"ok":1}', { status: 200 })), ms)
    s?.addEventListener('abort', () => { clearTimeout(timer); rej(s.reason) })
  }))
}

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

  it('lets a per-call timeout of 0 disable a per-request timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":1}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      requests: { slow: new Request<Record<string, never>, { ok: number }>({ method: 'GET', path: '/slow', timeout: 5 }) },
    })
    // Per-request timeout is 5ms; a per-call 0 must disable it entirely rather
    // than falling through to the per-request value.
    const r = await api.slow({}, { timeout: 0 })
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: 1 })
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

  // ---------------------------------------------------------------------------
  // C1: AbortSignal.timeout() accepts only an integer in [0, 2^31 - 1] and
  // throws a RangeError otherwise. A fractional deadline is ordinary — a
  // `budget / 3`, a `seconds * 1000 * 1.5`, a `Number(process.env.TIMEOUT)` —
  // and the throw happened during setup, so the fetch was never issued at all:
  // the caller got `kind: 'network'` with a RangeError body, indistinguishable
  // from being offline, on every single call to that endpoint.
  // ---------------------------------------------------------------------------
  it('accepts a fractional timeout instead of never sending the request', async () => {
    const f = hangingFetch()
    vi.stubGlobal('fetch', f)
    const api = createApi({
      baseUrl: '',
      requests: { slow: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', timeout: 20.5 }) },
    })
    const r = await api.slow()
    expect(f).toHaveBeenCalled()                       // the request was actually issued
    expect(r.error!.body).not.toBeInstanceOf(RangeError)
    expect(r.error!.kind).toBe('timeout')              // a real deadline, not a setup failure
  })

  it('clamps a timeout past the 32-bit timer ceiling instead of firing at ~1ms', async () => {
    // Node wraps anything over 2^31 - 1 round to a 1ms timer (with a
    // TimeoutOverflowWarning), which turns "effectively no deadline" into
    // "abort immediately".
    vi.stubGlobal('fetch', delayedFetch(30))
    const api = createApi({
      baseUrl: '',
      requests: { far: new Request<Record<string, never>, { ok: number }>({ method: 'GET', path: '/far', timeout: 2 ** 31 }) },
    })
    const r = await api.far()
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: 1 })
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
