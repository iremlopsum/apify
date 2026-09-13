import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { ApiError } from '../src/result.js'
import type { Middleware } from '../src/types.js'

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
})
