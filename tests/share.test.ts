import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

function controllable() {
  const calls: { resolve: () => void; aborted: () => boolean }[] = []
  const fn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const s = init.signal as AbortSignal | undefined
    s?.addEventListener('abort', () => rej(s.reason))
    calls.push({
      resolve: () => res(new Response('{"ok":1}', { status: 200 })),
      aborted: () => !!s?.aborted,
    })
  }))
  return { fn, calls }
}

const shared = () => createApi({
  baseUrl: '',
  requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
})

describe('share', () => {
  afterEach(() => vi.restoreAllMocks())

  it('coalesces identical simultaneous calls into one fetch', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const all = Promise.all([api.get({ id: '1' }), api.get({ id: '1' }), api.get({ id: '1' })])
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(1)
    f.calls[0].resolve()
    const results = await all
    expect(results.every(r => r.error === null)).toBe(true)
  })

  it('does not coalesce different params', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const all = Promise.all([api.get({ id: '1' }), api.get({ id: '2' })])
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(2)
    f.calls[0].resolve(); f.calls[1].resolve()
    await all
  })

  it('does not coalesce when per-call headers are present', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const all = Promise.all([
      api.get({ id: '1' }),
      api.get({ id: '1' }, { headers: { 'X-Tenant': 'b' } }),
    ])
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(2)
    f.calls[0].resolve(); f.calls[1].resolve()
    await all
  })

  it('lets one sharer abort without harming the others', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const ac = new AbortController()
    const a = api.get({ id: '1' }, { signal: ac.signal })
    const b = api.get({ id: '1' })
    await Promise.resolve()
    ac.abort()
    expect((await a).error?.kind).toBe('abort')
    expect(f.calls[0].aborted()).toBe(false)
    f.calls[0].resolve()
    expect((await b).error).toBeNull()
  })

  it('aborts the underlying request when the last sharer aborts', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const a1 = new AbortController(), a2 = new AbortController()
    const a = api.get({ id: '1' }, { signal: a1.signal })
    const b = api.get({ id: '1' }, { signal: a2.signal })
    await Promise.resolve()
    a1.abort()
    await a
    expect(f.calls[0].aborted()).toBe(false)
    a2.abort()
    await b
    expect(f.calls[0].aborted()).toBe(true)
  })

  it('throws at createApi when share and dedupe are both set', () => {
    expect(() => createApi({
      baseUrl: '',
      requests: { bad: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/b', share: true, dedupe: true }) },
    })).toThrow(/bad/)
  })

  it('bounds only its own caller with a per-call timeout', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const impatient = api.get({ id: '1' }, { timeout: 20 })
    const patient = api.get({ id: '1' })
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(1)              // a timeout does not prevent sharing

    const r = await impatient
    expect(r.error?.kind).toBe('timeout')
    expect(f.calls[0].aborted()).toBe(false)            // the shared request continues

    f.calls[0].resolve()
    expect((await patient).error).toBeNull()
  })

  it('starts a new request once the shared one has settled', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const first = api.get({ id: '1' }); await Promise.resolve()
    f.calls[0].resolve(); await first
    const second = api.get({ id: '1' }); await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(2)
    f.calls[1].resolve(); await second
  })
})
