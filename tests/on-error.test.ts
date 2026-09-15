import { describe, it, expect, vi, afterEach } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { Middleware } from '../src/types.js'

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

// ---------------------------------------------------------------------------
// Round 2 review, Findings 1 & 2: the guard above tests `error.kind`, but
// `error.kind` itself must be classified by PROVENANCE (did our own signal
// abort?), not by sniffing the reason's `.name`. Two consequences of getting
// this wrong, both measured against `e15f048`:
//
//   1. a middleware that rethrows its own AbortError-named failure — nothing
//      to do with this request's own cancellation, e.g. a rethrown IndexedDB
//      quota abort — used to classify as kind: 'abort' purely because its
//      name matched, and so was silently swallowed instead of reaching
//      onError as the middleware bug it is.
//   2. an unshared caller using the MDN-documented `ac.abort(reason)` form
//      with a custom (non-AbortError-named) reason used to classify as
//      kind: 'network' and so still reported to onError — the exact Sentry
//      noise this task set out to remove, just mislabelled as "offline".
//      Shared callers (via the share-site `onAbort`) already classified this
//      correctly as 'abort'; only the unshared path disagreed.
// ---------------------------------------------------------------------------
describe('abort classification is by provenance, not by the reason\'s name', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not swallow a middleware failure that merely looks like an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const k: string[] = []
    const idbAbort: Middleware = async () => {
      throw new DOMException('idb transaction aborted', 'AbortError')
    }
    const api = createApi({ baseUrl: '', middleware: [idbAbort], onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) } })
    const r = await api.g()
    expect(r.error!.kind).toBe('middleware')
    await flush()
    expect(k).toEqual(['middleware'])
  })

  it('classifies a custom abort reason as abort (not network), and still suppresses it', async () => {
    vi.stubGlobal('fetch', hang())
    const k: string[] = []
    const ac = new AbortController()
    const api = createApi({ baseUrl: '', onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) } })
    const p = api.g({}, { signal: ac.signal })
    ac.abort(new Error('component unmounted'))
    const r = await p
    expect(r.error!.kind).toBe('abort')
    expect(r.error!.body).toBeInstanceOf(Error)
    await flush()
    expect(k).toEqual([])
  })

  // Round 3 review, Finding 2 (new from the round 2 fix): the identity check
  // `reason === signal.reason` was too strict. `node:timers/promises`'
  // `setTimeout(ms, undefined, { signal })` — a realistic building block for
  // a middleware's backoff sleep, queue, or IndexedDB wrapper — rejects with
  // a FRESH AbortError whose `.cause` is the signal's reason, not the reason
  // itself (confirmed directly: `err === signal.reason` is false, `err.cause
  // === signal.reason` is true). Without accepting that one-level `.cause`
  // match, a middleware genuinely propagating a user's cancellation through
  // such a helper misclassified as its own failure ('middleware') instead of
  // the user's ('abort'). This must NOT reopen the IndexedDB scenario in the
  // test above — that one's `.cause` is undefined, not our signal's reason,
  // so it still correctly classifies as 'middleware'.
  it('propagates a cancellation through a middleware even when the abort helper wraps it in a fresh AbortError (.cause)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const k: string[] = []
    const abortableSleep: Middleware = async ctx => {
      await delay(5000, undefined, { signal: ctx.request.signal })
      throw new Error('should never get here — the delay always aborts first')
    }
    const ac = new AbortController()
    const api = createApi({ baseUrl: '', middleware: [abortableSleep], onError: e => k.push(e.kind),
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) } })
    const p = api.g({}, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.error!.kind).toBe('abort')
    await flush()
    expect(k).toEqual([])
  })
})
