import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

const hang = () => vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => {
  const s = init.signal as AbortSignal | undefined
  if (s?.aborted) { rej(s.reason); return }
  s?.addEventListener('abort', () => rej(s.reason))
}))
const flush = () => new Promise(r => setTimeout(r, 40))

describe('onError and aborts', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not fire for a caller-initiated abort', async () => {
    vi.stubGlobal('fetch', hang())
    const k: string[] = []
    const ac = new AbortController()
    const api = createApi({ baseUrl: '', onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) } })
    const p = api.g({}, { signal: ac.signal })
    ac.abort()
    expect((await p).error!.kind).toBe('abort')
    await flush()
    expect(k).toEqual([])
  })

  it('does not fire for a dedupe supersede', async () => {
    vi.stubGlobal('fetch', hang())
    const k: string[] = []
    const api = createApi({ baseUrl: '', onError: e => k.push(e.kind),
      requests: { s: new Request<{ q: string }, unknown>({ method: 'GET', path: '/s', dedupe: true }) } })
    const a = api.s({ q: 'a' }); const b = api.s({ q: 'b' })
    await a; await flush()
    expect(k).toEqual([])
    // `b` is the newer call that superseded `a` — it stays the live request
    // and, per the `hang()` mock above, never settles on its own in this
    // test (nothing ever resolves or aborts its fetch). apify's Result
    // promise never rejects, so `.catch` here is only a safety net against
    // an unhandled-rejection warning for the still-pending promise; it is
    // deliberately not awaited, since awaiting it would hang forever.
    b.catch(() => {})
  })

  it('STILL fires for a timeout', async () => {
    vi.stubGlobal('fetch', hang())
    const k: string[] = []
    const api = createApi({ baseUrl: '', onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g', timeout: 20 }) } })
    await api.g(); await flush()
    expect(k).toEqual(['timeout'])
  })

  it('still fires for HTTP and network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('e', { status: 500 })))
    const k: string[] = []
    const api = createApi({ baseUrl: '', onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) } })
    await api.g(); await flush()
    expect(k).toEqual(['http'])
  })
})
