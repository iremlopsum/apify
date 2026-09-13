import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { cacheMiddleware } from '../src/built-in-middleware.js'

function deferredFetch() {
  const calls: { resolve: () => void; aborted: () => boolean }[] = []
  const fn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const signal = init.signal as AbortSignal | undefined
    signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))
    calls.push({
      resolve: () => res(new Response('{"ok":1}', { status: 200 })),
      aborted: () => !!signal?.aborted,
    })
  }))
  return { fn, calls }
}

describe('dedupe does not fire when a middleware short-circuits', () => {
  let f: ReturnType<typeof deferredFetch>
  beforeEach(() => { f = deferredFetch(); vi.stubGlobal('fetch', f.fn) })
  afterEach(() => vi.restoreAllMocks())

  it('a cache hit leaves a live in-flight request alone', async () => {
    const cache = cacheMiddleware({ ttl: 60_000 })
    const api = createApi({
      baseUrl: '',
      requests: {
        get: new Request<{ id: string }, unknown>({
          method: 'GET', path: '/x/:id', dedupe: true, middleware: [cache],
        }),
      },
    })

    const warm = api.get({ id: '1' }); f.calls[0].resolve(); await warm
    const inflight = api.get({ id: '2' })
    await Promise.resolve()
    await api.get({ id: '1' })                 // served from cache — must not abort

    expect(f.fn.mock.calls.length).toBe(2)
    expect(f.calls[1].aborted()).toBe(false)

    f.calls[1].resolve()
    await inflight
  })
})

describe('dedupe and retry compose', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 }))))
  afterEach(() => vi.restoreAllMocks())

  it('a retried request is not cancelled by its own earlier attempt', async () => {
    const { retryMiddleware } = await import('../src/built-in-middleware.js')
    const api = createApi({
      baseUrl: '',
      middleware: [retryMiddleware(2)],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g', dedupe: true }) },
    })
    const r = await api.g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
    expect(r.error!.status).toBe(503)          // 503, not 0 — no self-abort
  })
})
