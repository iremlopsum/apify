import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { createGraphQL, Operation, gql } from '../src/graphql.js'
import type { Middleware, Result } from '../src/types.js'

// ---------------------------------------------------------------------------
// A middleware that never settles must not hold a call past its own deadline.
//
// `timeout` is documented as covering "the entire middleware chain", but
// before 4.4.2 the deadline only took effect once a middleware called
// `next()` and the request reached `fetch`. A middleware awaiting something
// that never settled — the usual trigger is an auth token refresh stalling —
// left the call pending forever, with no Result and no onError. The same
// held for a caller's own `CallOptions.signal`.
//
// Every "hung" assertion below races the call against a sentinel rather than
// awaiting it directly, so a regression fails as an AssertionError instead of
// as a vitest timeout that says nothing about why.
// ---------------------------------------------------------------------------

const HUNG = Symbol('hung')

/** Resolves with the call's Result, or with `HUNG` if it has not settled within `ms`. */
function within<T>(p: Promise<T>, ms = 1000): Promise<T | typeof HUNG> {
  return Promise.race([p, new Promise<typeof HUNG>(r => setTimeout(() => r(HUNG), ms))])
}

/** Drains every pending microtask and then one macrotask. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A middleware that parks until `release()` is called, then runs `then`. */
function parked(then: (next: () => Promise<Result<unknown>>) => Promise<Result<unknown>>) {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const mw: Middleware = async (_ctx, next) => {
    await gate
    return then(next)
  }
  return { mw, release: () => release() }
}

const never: Middleware = () => new Promise(() => {})

const okFetch = () => vi.fn(async () => new Response('{"data":{"ok":true}}', { status: 200 }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// createGraphQL
// ---------------------------------------------------------------------------

describe('createGraphQL — a hung middleware', () => {
  const op = (timeout?: number) => new Operation<Record<string, never>, { ok: boolean }>({
    operation: gql`query { ok }`,
    timeout,
  })

  it('settles with kind "timeout" when OperationConfig.timeout fires', async () => {
    const fetch = okFetch(); vi.stubGlobal('fetch', fetch)
    const kinds: string[] = []
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [never],
      onError: e => { kinds.push(e.kind) },
      operations: { op: op(50) },
    })

    const started = Date.now()
    const r = await within(client.op())
    expect(r).not.toBe(HUNG)
    const result = r as Result<{ ok: boolean }>
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.status).toBe(0)
    expect(result.response).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
    await flush()
    expect(kinds).toEqual(['timeout'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('settles with kind "abort" when the caller aborts, and does not report it', async () => {
    vi.stubGlobal('fetch', okFetch())
    const kinds: string[] = []
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [never],
      onError: e => { kinds.push(e.kind) },
      operations: { op: op() },
    })

    const ac = new AbortController()
    const p = client.op({}, { signal: ac.signal })
    ac.abort()
    const r = await within(p)
    expect(r).not.toBe(HUNG)
    expect((r as Result<unknown>).error?.kind).toBe('abort')
    await flush()
    expect(kinds).toEqual([])
  })

  it('does not send the request, or report twice, when the middleware later resumes and calls next()', async () => {
    const fetch = okFetch(); vi.stubGlobal('fetch', fetch)
    const kinds: string[] = []
    let late: Result<unknown> | undefined
    const gate = parked(async next => { late = await next(); return late })
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [gate.mw],
      onError: e => { kinds.push(e.kind) },
      operations: { op: op(30) },
    })

    const r = await within(client.op())
    expect((r as Result<unknown>).error?.kind).toBe('timeout')

    gate.release()
    await flush(); await flush()
    expect(late).toBeDefined() // the resumed chain did run to completion
    expect(fetch).not.toHaveBeenCalled()
    expect(kinds).toEqual(['timeout'])
  })

  it('does not report twice when the middleware later resumes and throws', async () => {
    vi.stubGlobal('fetch', okFetch())
    const kinds: string[] = []
    const gate = parked(async () => { throw new Error('late failure') })
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [gate.mw],
      onError: e => { kinds.push(e.kind) },
      operations: { op: op(30) },
    })

    const r = await within(client.op())
    expect((r as Result<unknown>).error?.kind).toBe('timeout')
    gate.release()
    await flush(); await flush()
    expect(kinds).toEqual(['timeout'])
  })

  it('gives result.retry() a fresh budget', async () => {
    vi.stubGlobal('fetch', okFetch())
    let calls = 0
    const hangOnce: Middleware = (_ctx, next) => (++calls === 1 ? new Promise(() => {}) : next())
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [hangOnce],
      operations: { op: op(30) },
    })

    const first = await within(client.op())
    expect((first as Result<unknown>).error?.kind).toBe('timeout')
    const second = await within((first as Result<unknown>).retry())
    expect((second as Result<{ ok: boolean }>).data).toEqual({ ok: true })
  })

  it('a late next() under dedupe neither aborts nor unregisters a newer call', async () => {
    const signals: AbortSignal[] = []
    const resolvers: (() => void)[] = []
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
      const s = init.signal as AbortSignal
      signals.push(s)
      s.addEventListener('abort', () => rej(s.reason))
      resolvers.push(() => res(new Response('{"data":{"ok":true}}', { status: 200 })))
    })))

    let first = true
    let releaseFirst!: () => void
    const gate = new Promise<void>(r => { releaseFirst = r })
    const hangFirst: Middleware = async (_ctx, next) => {
      if (first) { first = false; await gate }
      return next()
    }
    const client = createGraphQL({
      endpoint: 'https://api.test/graphql',
      middleware: [hangFirst],
      operations: {
        op: new Operation<Record<string, never>, { ok: boolean }>({ operation: gql`query { ok }`, dedupe: true, timeout: 30 }),
      },
    })

    const a = await within(client.op())
    expect((a as Result<unknown>).error?.kind).toBe('timeout')

    const b = client.op({}, { timeout: 0 })
    await flush()
    expect(signals).toHaveLength(1) // b is in flight

    releaseFirst()
    await flush(); await flush()
    expect(signals).toHaveLength(1) // a's resumed next() sent nothing
    expect(signals[0].aborted).toBe(false) // ...and did not supersede b

    // b still owns its dedupe entry: a newer call supersedes it as normal.
    const c = client.op({}, { timeout: 0 })
    await flush()
    expect(signals[0].aborted).toBe(true)
    expect((await b).error?.kind).toBe('abort')
    resolvers[1]()
    expect((await c).data).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// createApi — unshared
// ---------------------------------------------------------------------------

describe('createApi — a hung middleware', () => {
  const req = (config: { timeout?: number; dedupe?: boolean } = {}) =>
    new Request<Record<string, never>, { ok: boolean }>({ method: 'GET', path: '/x', ...config })

  it('settles with kind "timeout" when RequestConfig.timeout fires', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })); vi.stubGlobal('fetch', fetch)
    const kinds: string[] = []
    const api = createApi({
      baseUrl: 'https://api.test',
      middleware: [never],
      onError: e => { kinds.push(e.kind) },
      requests: { x: req({ timeout: 50 }) },
    })

    const started = Date.now()
    const r = await within(api.x())
    expect(r).not.toBe(HUNG)
    const result = r as Result<unknown>
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.status).toBe(0)
    expect(result.error?.request.url).toBe('https://api.test/x')
    expect(Date.now() - started).toBeLessThan(500)
    await flush()
    expect(kinds).toEqual(['timeout'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('settles with kind "timeout" when a per-call timeout fires', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const api = createApi({ baseUrl: '', middleware: [never], requests: { x: req() } })
    const r = await within(api.x({}, { timeout: 30 }))
    expect((r as Result<unknown>).error?.kind).toBe('timeout')
  })

  it('settles with kind "abort" when the caller aborts, and does not report it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const kinds: string[] = []
    const api = createApi({ baseUrl: '', middleware: [never], onError: e => { kinds.push(e.kind) }, requests: { x: req() } })

    const ac = new AbortController()
    const p = api.x({}, { signal: ac.signal })
    ac.abort()
    const r = await within(p)
    expect(r).not.toBe(HUNG)
    expect((r as Result<unknown>).error?.kind).toBe('abort')
    await flush()
    expect(kinds).toEqual([])
  })

  it('settles when the caller signal was already aborted before the call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const api = createApi({ baseUrl: '', middleware: [never], requests: { x: req() } })
    const r = await within(api.x({}, { signal: AbortSignal.abort() }))
    expect((r as Result<unknown>).error?.kind).toBe('abort')
  })

  it('does not send the request, or report twice, when the middleware later resumes and calls next()', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })); vi.stubGlobal('fetch', fetch)
    const kinds: string[] = []
    let late: Result<unknown> | undefined
    const gate = parked(async next => { late = await next(); return late })
    const api = createApi({ baseUrl: '', middleware: [gate.mw], onError: e => { kinds.push(e.kind) }, requests: { x: req({ timeout: 30 }) } })

    const r = await within(api.x())
    expect((r as Result<unknown>).error?.kind).toBe('timeout')

    gate.release()
    await flush(); await flush()
    expect(late).toBeDefined()
    expect(late!.error?.kind).toBe('timeout') // what the resumed next() hands back
    expect(fetch).not.toHaveBeenCalled()
    expect(kinds).toEqual(['timeout'])
  })

  it('does not send the request even when the resumed middleware installed a live signal of its own', async () => {
    // Real fetch refuses an already-aborted signal on its own, so the case
    // that proves the guard is a middleware that swapped in a fresh signal.
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })); vi.stubGlobal('fetch', fetch)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const swapper: Middleware = async (ctx, next) => {
      await gate
      ctx.request.signal = new AbortController().signal
      return next()
    }
    const api = createApi({ baseUrl: '', middleware: [swapper], requests: { x: req({ timeout: 30 }) } })

    expect(((await within(api.x())) as Result<unknown>).error?.kind).toBe('timeout')
    release()
    await flush(); await flush()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not report twice when the middleware later resumes and throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const kinds: string[] = []
    const gate = parked(async () => { throw new Error('late failure') })
    const api = createApi({ baseUrl: '', middleware: [gate.mw], onError: e => { kinds.push(e.kind) }, requests: { x: req({ timeout: 30 }) } })

    expect(((await within(api.x())) as Result<unknown>).error?.kind).toBe('timeout')
    gate.release()
    await flush(); await flush()
    expect(kinds).toEqual(['timeout'])
  })

  it('gives result.retry() a fresh budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    let calls = 0
    const hangOnce: Middleware = (_ctx, next) => (++calls === 1 ? new Promise(() => {}) : next())
    const api = createApi({ baseUrl: '', middleware: [hangOnce], requests: { x: req({ timeout: 30 }) } })

    const first = (await within(api.x())) as Result<unknown>
    expect(first.error?.kind).toBe('timeout')
    const second = (await within(first.retry())) as Result<unknown>
    expect(second.data).toEqual({ ok: true })
  })

  it('a hung response-side middleware cannot hold a timed-out call either', async () => {
    // The middleware reaches fetch, the deadline aborts it, and the middleware
    // then parks on post-processing (telemetry, say) that never finishes.
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal
      s.addEventListener('abort', () => rej(s.reason))
    })))
    const afterNext: Middleware = async (_ctx, next) => {
      await next()
      return new Promise(() => {})
    }
    const api = createApi({ baseUrl: '', middleware: [afterNext], requests: { x: req({ timeout: 30 }) } })
    const r = await within(api.x())
    expect((r as Result<unknown>).error?.kind).toBe('timeout')
  })

  it('a late next() under dedupe neither aborts nor unregisters a newer call', async () => {
    const signals: AbortSignal[] = []
    const resolvers: (() => void)[] = []
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
      const s = init.signal as AbortSignal
      signals.push(s)
      s.addEventListener('abort', () => rej(s.reason))
      resolvers.push(() => res(new Response('{"ok":true}', { status: 200 })))
    })))

    let first = true
    let releaseFirst!: () => void
    const gate = new Promise<void>(r => { releaseFirst = r })
    const hangFirst: Middleware = async (_ctx, next) => {
      if (first) { first = false; await gate }
      return next()
    }
    const api = createApi({ baseUrl: '', middleware: [hangFirst], requests: { x: req({ dedupe: true, timeout: 30 }) } })

    expect(((await within(api.x())) as Result<unknown>).error?.kind).toBe('timeout')

    const b = api.x({}, { timeout: 0 })
    await flush()
    expect(signals).toHaveLength(1)

    releaseFirst()
    await flush(); await flush()
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)

    const c = api.x({}, { timeout: 0 })
    await flush()
    expect(signals[0].aborted).toBe(true)
    expect((await b).error?.kind).toBe('abort')
    resolvers[1]()
    expect((await c).data).toEqual({ ok: true })
  })

  it('a dedupe supersede settles a call parked after next() with kind "abort"', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"n":${++n}}`, { status: 200 })))
    let parkFirst = true
    const parkAfter: Middleware = async (_ctx, next) => {
      const r = await next()
      if (parkFirst) { parkFirst = false; return new Promise(() => {}) }
      return r
    }
    const api = createApi({ baseUrl: '', middleware: [parkAfter], requests: { x: req({ dedupe: true }) } })

    const a = api.x()
    await flush()
    const b = api.x()
    const ra = (await within(a)) as Result<unknown>
    expect(ra.error?.kind).toBe('abort')
    expect(((await within(b)) as Result<unknown>).data).toEqual({ n: 2 })
  })
})

// ---------------------------------------------------------------------------
// createApi — share: true
// ---------------------------------------------------------------------------

describe('createApi share: true — a hung middleware on the shared request', () => {
  const req = (timeout?: number) =>
    new Request<{ id: string }, { ok: boolean }>({ method: 'GET', path: '/x/:id', share: true, timeout })

  it('settles every sharer when only RequestConfig.timeout applies, and reports once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const kinds: string[] = []
    const mw = vi.fn(never)
    const api = createApi({ baseUrl: '', middleware: [mw], onError: e => { kinds.push(e.kind) }, requests: { x: req(40) } })

    const [a, b] = await Promise.all([within(api.x({ id: '1' })), within(api.x({ id: '1' }))])
    expect((a as Result<unknown>).error?.kind).toBe('timeout')
    expect((b as Result<unknown>).error?.kind).toBe('timeout')
    expect(mw).toHaveBeenCalledTimes(1) // one shared chain
    await flush()
    expect(kinds).toEqual(['timeout'])

    // The shared slot was released: the next call starts a fresh request.
    void api.x({ id: '1' })
    await flush()
    expect(mw).toHaveBeenCalledTimes(2)
  })

  it('bounds a sharer by the shorter RequestConfig.timeout even when its per-call timeout is longer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const api = createApi({ baseUrl: '', middleware: [never], requests: { x: req(30) } })
    const started = Date.now()
    const r = (await within(api.x({ id: '1' }, { timeout: 5000 }))) as Result<unknown>
    expect(r.error?.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('when every sharer gives up, the refcount still aborts the shared request and the slot is freed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const kinds: string[] = []
    const seen: AbortSignal[] = []
    const capture: Middleware = ctx => { seen.push(ctx.request.signal!); return new Promise(() => {}) }
    const api = createApi({ baseUrl: '', middleware: [capture], onError: e => { kinds.push(e.kind) }, requests: { x: req() } })

    const [a, b] = await Promise.all([
      within(api.x({ id: '1' }, { timeout: 20 })),
      within(api.x({ id: '1' }, { timeout: 20 })),
    ])
    expect((a as Result<unknown>).error?.kind).toBe('timeout')
    expect((b as Result<unknown>).error?.kind).toBe('timeout')
    expect(seen).toHaveLength(1)
    expect(seen[0].aborted).toBe(true)

    await flush(); await flush()
    // One report per caller that gave up; the abandoned operation adds none.
    expect(kinds).toEqual(['timeout', 'timeout'])

    void api.x({ id: '1' }, { timeout: 20 })
    await flush()
    expect(seen).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Behaviour that must NOT change
// ---------------------------------------------------------------------------

describe('a middleware that settles on its own is unaffected', () => {
  it('a middleware that answers an abort with its own Result still wins', async () => {
    // The fallback pattern: catch the deadline and serve something else. The
    // chain answered the abort promptly, so the library must not preempt it.
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal
      s.addEventListener('abort', () => rej(s.reason))
    })))
    const fallback: Middleware = async (ctx, next) => {
      const r = await next()
      if (r.error?.kind !== 'timeout') return r
      await Promise.resolve() // a little async work of its own
      return { data: { fallback: true }, error: null, response: new Response('{}'), retry: r.retry } as Result<unknown>
    }
    const api = createApi({
      baseUrl: '', middleware: [fallback],
      requests: { x: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', timeout: 20 }) },
    })
    const r = (await within(api.x())) as Result<unknown>
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ fallback: true })
  })

  it('arms no timer for a call that settles within its budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const passThrough: Middleware = (_ctx, next) => next()
    const api = createApi({
      baseUrl: '', middleware: [passThrough],
      requests: { x: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', timeout: 1000 }) },
    })
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const r = await api.x()
    expect(r.error).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves no listener behind on a long-lived caller signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    const ac = new AbortController()
    let live = 0
    const add = ac.signal.addEventListener.bind(ac.signal)
    const remove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { live++; add(...args) }) as AbortSignal['addEventListener']
    ac.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { live--; remove(...args) }) as AbortSignal['removeEventListener']

    const api = createApi({
      baseUrl: '',
      requests: { x: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x' }) },
    })
    for (let i = 0; i < 5; i++) expect((await api.x({}, { signal: ac.signal })).error).toBeNull()
    expect(live).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The documented trade-off, and its documented remedy (MIGRATION.md, 4.4.2)
// ---------------------------------------------------------------------------

describe('a fallback that needs real I/O after the deadline', () => {
  const hangingFetch = () => vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
    const s = init.signal as AbortSignal
    s.addEventListener('abort', () => rej(s.reason))
  }))
  const io = () => new Promise(res => setTimeout(res, 15))
  const cached = (r: Result<unknown>) =>
    ({ data: { fallback: true }, error: null, response: new Response('{}'), retry: r.retry }) as Result<unknown>

  it('loses to the deadline when it answers slower than one macrotask', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const slowFallback: Middleware = async (_ctx, next) => {
      const r = await next()
      if (r.error?.kind !== 'timeout') return r
      await io()
      return cached(r)
    }
    const api = createApi({
      baseUrl: '', middleware: [slowFallback],
      requests: { x: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', timeout: 20 }) },
    })
    const r = (await within(api.x())) as Result<unknown>
    expect(r.error?.kind).toBe('timeout')
  })

  it('wins when it owns an earlier deadline of its own', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const withFallback: Middleware = async (ctx, next) => {
      ctx.request.signal = AbortSignal.timeout(20)   // inside the call's 200
      const r = await next()
      if (r.error?.kind !== 'timeout') return r
      await io()
      return cached(r)
    }
    const api = createApi({
      baseUrl: '', middleware: [withFallback],
      requests: { x: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', timeout: 200 }) },
    })
    const r = (await within(api.x())) as Result<unknown>
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ fallback: true })
  })
})

describe('what ctx.request.signal holds (README, MiddlewareContext)', () => {
  it('carries the timeout even when the caller passed no signal, and is undefined with neither', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const seen: (AbortSignal | undefined)[] = []
    const read: Middleware = (ctx, next) => { seen.push(ctx.request.signal); return next() }
    const api = createApi({
      baseUrl: '', middleware: [read],
      requests: {
        timed: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/t', timeout: 1000 }),
        plain: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/p' }),
      },
    })
    await api.timed()
    await api.plain()
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[1]).toBeUndefined()
  })
})
