import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { ApiError } from '../src/result.js'
import { cacheMiddleware } from '../src/built-in-middleware.js'
import type { Middleware } from '../src/types.js'

/**
 * Flushes the entire microtask queue: a macrotask (`setTimeout`) only runs
 * once every pending microtask has drained, so this guarantees any onError
 * report still in flight through a promise chain has fired before we assert
 * on it — regardless of how many `.then` hops separate it from the last
 * `await` in the test.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

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

  it('does not coalesce when per-call middleware is present', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const passthrough: Middleware = async (_ctx, next) => next()
    const all = Promise.all([
      api.get({ id: '1' }),
      api.get({ id: '1' }, { middleware: [passthrough] }),
    ])
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(2)
    f.calls[0].resolve(); f.calls[1].resolve()
    await all
  })

  // ---------------------------------------------------------------------------
  // Finding 1 (CRITICAL, post-review): stableStringify collapses FormData,
  // Blob, ArrayBuffer and URLSearchParams to the literal string "{}" because
  // it falls through to Object.keys() for any object, and Object.keys()
  // returns [] for all four of those types regardless of content. Without an
  // explicit exclusion, two concurrent share: true calls with genuinely
  // different payloads of one of these types would collide on the same share
  // key, coalesce into a single request, and hand one caller the response to
  // the OTHER caller's payload — with that caller's own payload never sent
  // at all. This proves the fix: two different FormData payloads make two
  // real requests, and each caller gets its own response.
  // ---------------------------------------------------------------------------
  it('does not coalesce different FormData payloads (special-body params defeat stableStringify)', async () => {
    const calls: { resolve: (data: unknown) => void }[] = []
    const fn = vi.fn((_u: string, _init: RequestInit) => new Promise<Response>(res => {
      calls.push({ resolve: (data: unknown) => res(new Response(JSON.stringify(data), { status: 200 })) })
    }))
    vi.stubGlobal('fetch', fn)

    const api = createApi({
      baseUrl: '',
      requests: { upload: new Request<FormData, { who: string }>({ method: 'POST', path: '/upload', share: true }) },
    })

    const fdA = new FormData(); fdA.append('payload', 'SECRET-A')
    const fdB = new FormData(); fdB.append('payload', 'SECRET-B')

    const pA = api.upload(fdA)
    const pB = api.upload(fdB)
    await Promise.resolve()

    // Two distinct payloads must make two real requests — a single shared
    // request here would mean B's payload was never sent at all.
    expect(fn.mock.calls.length).toBe(2)

    calls[0].resolve({ who: 'A' })
    calls[1].resolve({ who: 'B' })

    const [rA, rB] = await Promise.all([pA, pB])
    expect(rA.data).toEqual({ who: 'A' })
    expect(rB.data).toEqual({ who: 'B' }) // B must get its own response, never A's
  })

  // ---------------------------------------------------------------------------
  // Finding 2 (post-review): acquire() must not join an entry whose last
  // sharer has already released (refs <= 0) or whose controller is already
  // aborted — that entry is dying but hasn't been cleaned up yet, since
  // cleanup only runs once the real request's promise actually settles, at
  // least one microtask after a synchronous controller.abort(). A caller
  // that shows up in the same tick as the last release, with no await in
  // between, must get a genuine new request rather than a synthetic abort.
  // ---------------------------------------------------------------------------
  it('does not join a dying entry when a new call arrives before cleanup runs', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()
    const ac = new AbortController()

    const first = api.get({ id: '1' }, { signal: ac.signal })
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(1)

    ac.abort()                          // the only sharer releases -> refs 0, controller aborts synchronously
    const second = api.get({ id: '1' }) // no await between the abort and this call

    expect(f.fn.mock.calls.length).toBe(2) // must be a genuine new request, not a join

    const r1 = await first
    expect(r1.error?.kind).toBe('abort')

    f.calls[1].resolve()
    const r2 = await second
    expect(r2.error).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // C2: isSpecialBody, stableStringify and timeoutSignalFor all run in the bare
  // body of the api method, outside execute()'s try/catch — the one region of
  // the request path where "every call returns a Result" was not enforced by
  // construction. A BigInt timeout is the cheapest reachable trigger (TypeScript
  // forbids it; JavaScript callers and `as any` config loaders do not): Math.min
  // inside timeoutSignalFor throws a TypeError on it.
  // ---------------------------------------------------------------------------
  it('returns a Result when the share setup itself throws', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = shared()

    const r = await api.get({ id: '1' }, { timeout: 10n as unknown as number })

    expect(r.error).toBeInstanceOf(ApiError)
    expect(r.error!.kind).toBe('network')
    expect(r.error!.body).toBeInstanceOf(TypeError)
    // And nothing was left in flight: the throw happens before acquire(), so
    // there is no shared request holding a reference this caller never releases.
    expect(f.fn).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // C3: a rejection escaping the shared operation (an async middleware that
  // throws is the realistic case) used to be handed to the caller as if it
  // were a Result — `const { data, error } = await api.get(...)` then yielded
  // undefined/undefined, `if (error)` was false, and the consumer carried on as
  // though the call had succeeded with no data. Worse than the rejection it
  // replaced, because a rejection is at least loud.
  // ---------------------------------------------------------------------------
  it('hands every sharer a real Result when the shared operation rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const exploding: Middleware = async () => {
      await Promise.resolve()
      throw new Error('middleware exploded')
    }
    const api = createApi({
      baseUrl: '',
      requests: {
        get: new Request<{ id: string }, { ok: number }>({
          method: 'GET', path: '/x/:id', share: true, middleware: [exploding],
        }),
      },
    })

    const ac = new AbortController()
    const [plain, watched] = await Promise.all([
      api.get({ id: '1' }),                          // no per-caller signal: the direct path
      api.get({ id: '1' }, { signal: ac.signal }),   // with one: the race path
    ])

    for (const r of [plain, watched]) {
      expect(r.data).toBeNull()
      expect(r.error).toBeInstanceOf(ApiError)
      expect(r.error!.kind).toBe('network')
      expect((r.error!.body as Error).message).toBe('middleware exploded')
    }
  })

  // ---------------------------------------------------------------------------
  // I3: a sharer that gives up builds its Result directly, bypassing the
  // post-execution hook inside execute() where onError normally fires. A
  // shared timeout therefore reached no error tracker at all, and behaved
  // differently from the identical non-shared call — which defeats the whole
  // point of splitting 'timeout' from 'abort' (a timeout is a genuine failure
  // that belongs in an error tracker; a cancellation usually is not).
  // ---------------------------------------------------------------------------
  it("reports a sharer's own timeout to onError, as the non-shared call does", async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const kinds: (string | undefined)[] = []
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
    })

    const impatient = api.get({ id: '1' }, { timeout: 20 })
    const patient = api.get({ id: '1' })
    await Promise.resolve()

    expect((await impatient).error?.kind).toBe('timeout')
    expect(kinds).toEqual(['timeout'])

    f.calls[0].resolve()
    expect((await patient).error).toBeNull()
    expect(kinds).toEqual(['timeout'])   // the sharer that succeeded reports nothing
  })

  it("reports a sharer's own abort to onError", async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const kinds: (string | undefined)[] = []
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
    })

    const ac = new AbortController()
    const cancelled = api.get({ id: '1' }, { signal: ac.signal })
    api.get({ id: '1' })
    await Promise.resolve()
    ac.abort()

    expect((await cancelled).error?.kind).toBe('abort')
    expect(kinds).toEqual(['abort'])
  })

  // ---------------------------------------------------------------------------
  // I2: RequestConfig.timeout is documented as a whole-operation deadline and
  // specified as "a property of the operation itself, therefore shared by all
  // callers". It was neither: the share path suppressed it inside execute()
  // and applied it per-caller instead, measured from each caller's *join*
  // time. With a steady arrival of joiners the one real socket was never
  // released — measured at 1086ms against a configured 100ms deadline.
  // ---------------------------------------------------------------------------
  it('bounds the shared operation with the per-request timeout, even for a more patient caller', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = createApi({
      baseUrl: '',
      requests: {
        get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true, timeout: 30 }),
      },
    })

    // This caller asks for far more patience than the operation allows. Its own
    // budget bounds only itself; it cannot extend the operation's deadline.
    const started = Date.now()
    const r = await api.get({ id: '1' }, { timeout: 2000 })

    expect(r.error?.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(f.calls[0].aborted()).toBe(true)   // the shared request itself was cut off
  })

  // ---------------------------------------------------------------------------
  // Fix 3 (2.2.1): canShare shared isSpecialBody with cacheMiddleware's guard
  // for docs/FIXES.md #14, which also excludes a raw string — but
  // stableStringify keys a string correctly (via JSON.stringify), so a
  // string-param endpoint is soundly coalescable. Narrowed to isOpaqueParams
  // (the four object types only); FormData/Blob/ArrayBuffer/URLSearchParams
  // must still decline to coalesce (already covered by the tests above).
  // ---------------------------------------------------------------------------
  it('coalesces a string-param endpoint (a raw string is soundly keyable, unlike FormData/Blob/etc)', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    // `Request<TParams extends object, ...>` cannot name `string` itself — a
    // raw string body is a runtime-only concept (isOpaqueParams operates on
    // the erased `object` params createApi actually passes through), so the
    // call site casts past the declared (but here vacuous)
    // `Record<string, never>` params type, the same way the suite already
    // casts a BigInt timeout past `number` elsewhere in this file.
    const api = createApi({
      baseUrl: '',
      requests: { search: new Request<Record<string, never>, { ok: number }>({ method: 'POST', path: '/search', share: true }) },
    })
    const all = Promise.all([
      api.search('needle' as unknown as Record<string, never>),
      api.search('needle' as unknown as Record<string, never>),
    ])
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(1)
    f.calls[0].resolve()
    const results = await all
    expect(results.every(r => r.error === null)).toBe(true)
  })

  it('does not let a late joiner extend the shared operation deadline', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const api = createApi({
      baseUrl: '',
      requests: {
        get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true, timeout: 100 }),
      },
    })

    const started = Date.now()
    const first = api.get({ id: '1' })
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 60))

    // Joins the request already in flight, 60ms into its 100ms budget. Its own
    // generous per-call budget must not keep that socket alive past the
    // operation's deadline.
    const late = api.get({ id: '1' }, { timeout: 2000 })
    await Promise.resolve()
    expect(f.fn.mock.calls.length).toBe(1)    // still one shared request

    const [a, b] = await Promise.all([first, late])
    expect(a.error?.kind).toBe('timeout')
    expect(b.error?.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------
// Fix 1 (2.2.1, docs/FIXES.md "Duplicate onError under share"): a sharer that
// gives up reports its own failure via failedResult, which is correct and
// necessary for a non-last release — the shared execute() never fails on its
// own account, so nothing else would report it. But when the release IS the
// last one, it also aborts the shared controller (ShareTracker.release), and
// the shared execute()'s own post-execution hook then reports that same
// failure a second time. Target counts, per the four acceptance rows:
//
//   1 caller,  share, times out           -> was 2, now 1
//   2 callers, share, both abort          -> was 3, now 2 (one each)
//   3 sharers, shared request 500s        -> unchanged, 1
//   non-shared, times out                 -> unchanged, 1
// ---------------------------------------------------------------------------
describe('duplicate onError under share (Fix 1, 2.2.1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('row 1: reports exactly once when the lone sharer times out', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const kinds: (string | undefined)[] = []
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
    })

    const r = await api.get({ id: '1' }, { timeout: 20 })
    expect(r.error?.kind).toBe('timeout')

    await flush()
    expect(kinds).toEqual(['timeout'])
  })

  it('row 2: reports once per caller when two sharers both abort', async () => {
    const f = controllable(); vi.stubGlobal('fetch', f.fn)
    const kinds: (string | undefined)[] = []
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
    })

    const a1 = new AbortController()
    const a2 = new AbortController()
    const a = api.get({ id: '1' }, { signal: a1.signal })
    const b = api.get({ id: '1' }, { signal: a2.signal })
    await Promise.resolve()

    a1.abort()
    expect((await a).error?.kind).toBe('abort')

    a2.abort()
    expect((await b).error?.kind).toBe('abort')

    await flush()
    expect(kinds).toEqual(['abort', 'abort']) // one report per caller, not three
  })

  it('row 3 (unchanged): reports exactly once when the shared request itself 500s for 3 sharers', async () => {
    const kinds: (string | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: { get: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/x/:id', share: true }) },
    })

    const all = await Promise.all([api.get({ id: '1' }), api.get({ id: '1' }), api.get({ id: '1' })])
    expect(all.every(r => r.error?.kind === 'http')).toBe(true)

    await flush()
    expect(kinds).toEqual(['http'])
  })

  it('row 4 (unchanged): reports exactly once for a non-shared timeout', async () => {
    const kinds: (string | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal | undefined
      if (s?.aborted) { rej(s.reason); return }
      s?.addEventListener('abort', () => rej(s.reason))
    })))
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      // No `share` — the plain execute() path.
      requests: { get: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', timeout: 20 }) },
    })

    const r = await api.get()
    expect(r.error?.kind).toBe('timeout')

    await flush()
    expect(kinds).toEqual(['timeout'])
  })

  // ---------------------------------------------------------------------------
  // Review finding (2.2.1): `onAbort` inferred "the shared execute() will
  // report this" purely from `wasLast` — but the delegate (execute()'s
  // post-execution hook) only reports when the shared operation RESOLVES
  // WITH AN ERROR RESULT. Two reachable cases where it doesn't, both
  // reintroducing the zero-report gap the original fix set out to close:
  //
  //   row 5: the shared chain REJECTS (a middleware throws on abort — a
  //          token-fetching auth middleware is the realistic case)
  //   row 6: the shared chain SHORT-CIRCUITS TO SUCCESS (a cacheMiddleware
  //          hit, which we ship, ignores the abort signal entirely)
  //
  // In both, the last sharer's own onAbort skipped reporting (wasLast was
  // true) and the delegate never got a chance to report either — zero
  // reports for a real cancellation, worse than the duplicate this fix set
  // out to remove.
  // ---------------------------------------------------------------------------
  it('row 5: reports exactly once when the last sharer gives up and the shared chain rejects', async () => {
    const kinds: (string | undefined)[] = []
    // Simulates a token-fetching auth middleware that awaits the shared
    // signal and throws (rather than returning a Result) when it aborts —
    // never calling next(), so the rejection escapes execute() entirely.
    const throwsOnAbort: Middleware = ctx => new Promise((_resolve, reject) => {
      const s = ctx.request.signal
      if (s?.aborted) { reject(s.reason); return }
      s?.addEventListener('abort', () => reject(s.reason), { once: true })
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: {
        get: new Request<{ id: string }, { ok: number }>({
          method: 'GET', path: '/x/:id', share: true, middleware: [throwsOnAbort],
        }),
      },
    })

    const ac = new AbortController()
    const p = api.get({ id: '1' }, { signal: ac.signal }) // the only (thus last) sharer
    await Promise.resolve()
    ac.abort()

    const r = await p
    expect(r.error?.kind).toBe('abort')

    await flush()
    expect(kinds).toEqual(['abort']) // exactly one report, not zero
  })

  it('row 6: reports exactly once when the last sharer gives up against a cacheMiddleware hit', async () => {
    const kinds: (string | undefined)[] = []
    const cache = cacheMiddleware({ ttl: 60_000 })
    const fetchMock = vi.fn(async () => new Response('{"ok":1}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: {
        get: new Request<{ id: string }, { ok: number }>({
          method: 'GET', path: '/x/:id', share: true, middleware: [cache],
        }),
      },
    })

    // Warm the cache with an ordinary, uncontested call.
    await api.get({ id: '1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The only (thus last) sharer aborts before the cache hit's own promise
    // settles — no `await` in between, so the abort is observed before the
    // cache middleware's `return cached` has a chance to resolve. The cache
    // hit succeeds regardless of the abort (cacheMiddleware never looks at
    // the signal), so execute()'s post-execution hook sees a SUCCESS and has
    // nothing to report.
    const ac = new AbortController()
    const p = api.get({ id: '1' }, { signal: ac.signal })
    ac.abort()

    const r = await p
    expect(r.error?.kind).toBe('abort')          // the caller's own Result is still an abort
    expect(fetchMock).toHaveBeenCalledTimes(1)    // still a cache hit, no second network call

    await flush()
    expect(kinds).toEqual(['abort']) // exactly one report, not zero
  })
})

// ---------------------------------------------------------------------------
// Fix 2 (2.2.1): a caller that already gave up still has a live rejection
// handler on the shared promise. When the shared operation later rejects (an
// async middleware throwing is the realistic case), that handler used to
// build and report a Result even though `finish`'s `done` guard discards it —
// a second, differently-kinded report for a failure this caller already
// reported once. Measured on 2.2.0 with two callers (one aborts, then the
// shared middleware rejects): ['abort','network','network']. The aborted
// caller must report exactly once.
// ---------------------------------------------------------------------------
describe('cross-kind double report on a stale rejection handler (Fix 2, 2.2.1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not double-report a caller that already aborted when the shared operation later rejects', async () => {
    const kinds: (string | undefined)[] = []
    let releaseMiddleware: (() => void) | undefined
    const exploding: Middleware = async () => {
      await new Promise<void>(resolve => { releaseMiddleware = resolve })
      throw new Error('middleware exploded')
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      onError: e => { kinds.push(e.kind) },
      requests: {
        get: new Request<{ id: string }, { ok: number }>({
          method: 'GET', path: '/x/:id', share: true, middleware: [exploding],
        }),
      },
    })

    const ac = new AbortController()
    const aborted = api.get({ id: '1' }, { signal: ac.signal })
    const patient = api.get({ id: '1' }) // keeps the shared request alive
    await Promise.resolve()

    ac.abort()
    const abortedResult = await aborted
    expect(abortedResult.error?.kind).toBe('abort')

    await flush()
    expect(kinds).toEqual(['abort']) // exactly one report so far

    // Now let the shared middleware reject.
    releaseMiddleware!()
    const patientResult = await patient
    expect(patientResult.error?.kind).toBe('network')

    await flush()
    expect(kinds).toEqual(['abort', 'network']) // the aborted caller did not report again
  })
})
