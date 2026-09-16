import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { createGraphQL, Operation } from '../src/graphql.js'
import type { Middleware, ApiError } from '../src/types.js'

const boom: Middleware = async () => { throw new Error('middleware exploded') }

describe('a throwing middleware never rejects the caller', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))) })
  afterEach(() => { vi.restoreAllMocks() })

  it('non-shared path returns a Result', async () => {
    const api = createApi({
      baseUrl: '', middleware: [boom],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    const r = await api.g()
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('middleware')
    expect(String((r.error!.body as Error).message)).toContain('middleware exploded')
  })

  it('shared path returns a Result', async () => {
    const api = createApi({
      baseUrl: '', middleware: [boom],
      requests: { g: new Request<{ id: string }, unknown>({ method: 'GET', path: '/g/:id', share: true }) },
    })
    expect((await api.g({ id: '1' })).error!.kind).toBe('middleware')
  })

  // NOTE on this test's own history: the brief predicted this one "may
  // already pass before your change, because a synchronous throw from the
  // first middleware surfaces inside execute()'s existing try". That is true
  // only of the never-*rejects* half — measured, it did NOT already pass:
  // pre-fix it returned a Result (never rejected) but with kind 'network',
  // because a synchronous throw from composed(context) never produces a
  // promise for a bare `.catch(...)` to attach to — it escapes straight to
  // execute()'s outer catch, which is shared with genuine setup errors (e.g.
  // buildUrl's TypeError) and fallback-kinds them 'network'. The fix below
  // therefore wraps the composed(context) call in its own try/catch, right
  // alongside the `.catch` for the async case, so a synchronous middleware
  // throw is also classified 'middleware' rather than falling through to the
  // setup-error catch. This test DOES discriminate the fix (unlike what the
  // brief predicted) — keep it, it is not a no-op regression pin.
  it('a synchronously throwing middleware also returns a Result', async () => {
    const sync: Middleware = () => { throw new Error('sync boom') }
    const api = createApi({
      baseUrl: '', middleware: [sync],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    expect((await api.g()).error!.kind).toBe('middleware')
  })

  it('reports the middleware failure to onError exactly once', async () => {
    const kinds: string[] = []
    const api = createApi({
      baseUrl: '', middleware: [boom], onError: e => { kinds.push(e.kind) },
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    await api.g()
    await new Promise(r => setTimeout(r, 20))
    expect(kinds).toEqual(['middleware'])
  })

  // Round 4 review, Finding 1: `propagatesReason` (src/utils/abort-kind.ts)
  // reads `.cause` off `reason` — an arbitrary value a middleware threw —
  // and that read can itself throw (an accessor property, a `Proxy`, a
  // cross-realm wrapper). It runs inside the last-resort `.catch` whose
  // entire job is converting a rejection into a `Result`, so an unguarded
  // throw there escaped as an unhandled rejection: the exact "never throws"
  // contract this file exists to pin. `propagatesReason` is only ever
  // reached when the governing signal is already aborted (short-circuited
  // otherwise), so this needs an aborted `options.signal` to actually drive
  // execution into the throwing getter.
  it('a middleware throwing an object with a throwing .cause getter never rejects the caller', async () => {
    const evilCause: Middleware = async () => {
      const err = new Error('boom')
      Object.defineProperty(err, 'cause', { get() { throw new TypeError('boom from cause getter') } })
      throw err
    }
    const ac = new AbortController()
    ac.abort()
    const api = createApi({
      baseUrl: '', middleware: [evilCause],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    const r = await api.g({}, { signal: ac.signal })
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('middleware')
  })
})

// ---------------------------------------------------------------------------
// Round 5 review, Finding 1: round 4 guarded `propagatesReason`'s `.cause`
// read but not `abortKind`'s `.name` read — called from the SAME expression,
// one line below, inside the SAME last-resort `.catch`:
// `abortKind(signal!.reason) ?? 'abort'`. `signal.reason` is caller-supplied
// via `ac.abort(reason)`, exactly as arbitrary as anything a middleware
// throws — a revoked `Proxy`, a MobX/Vue reactive wrapper, or a class with a
// lazy `get name()` all reach it. Worse than a rejection: under `share: true`
// the throw happens inside `onAbort`, called synchronously from inside
// `ac.abort()`'s own event dispatch, BEFORE `finish(result)` runs — so the
// caller's promise never settles at all, and the throw escapes out of
// `ac.abort()` itself into whatever consumer code called it.
// ---------------------------------------------------------------------------
describe("abortKind's .name read never rejects or hangs the caller", () => {
  afterEach(() => { vi.restoreAllMocks() })

  const hostileReason = (): { name: string } => {
    const obj = {}
    Object.defineProperty(obj, 'name', { get() { throw new TypeError('hostile name getter') } })
    return obj as { name: string }
  }

  it('share: true, aborted in flight — the promise actually SETTLES (not merely: does not reject)', async () => {
    const fn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal | undefined
      s?.addEventListener('abort', () => rej(s.reason))
    }))
    vi.stubGlobal('fetch', fn)
    const api = createApi({
      baseUrl: '',
      requests: { g: new Request<{ id: string }, unknown>({ method: 'GET', path: '/g/:id', share: true }) },
    })
    // A SECOND, patient sharer (no signal of its own) is load-bearing here:
    // with only one sharer, that sharer's own release() would be the LAST
    // one, synchronously aborting the shared controller with the tracker's
    // own ABANDONED sentinel — a Symbol, immune to abortKind's `.name`
    // read — which lets the shared operation's OWN (unrelated, unpoisoned)
    // settlement path resolve this caller's promise anyway, masking the
    // hang `onAbort` itself would otherwise cause. With a second sharer
    // still holding a reference, this caller's release is NOT the last one,
    // nothing else will ever settle the shared operation in this test, and
    // `onAbort` throwing before `finish(result)` is the only thing standing
    // between this promise and settling — exactly what this test needs to
    // catch.
    const ac = new AbortController()
    const p = api.g({ id: '1' }, { signal: ac.signal })
    const patient = api.g({ id: '1' })
    await Promise.resolve()
    ac.abort(hostileReason())

    // A race against a short timer, not just `await p`: if `onAbort` throws
    // before `finish(result)`, the promise never settles at all, and a bare
    // `await p` would only ever show up as the *default* 5s test timeout —
    // indistinguishable from a slow assertion. This makes "never settles" a
    // fast, explicit failure instead.
    const outcome = await Promise.race([
      p.then(r => ({ settled: true as const, r })),
      new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 200)),
    ])
    expect(outcome.settled).toBe(true)
    if (outcome.settled) {
      expect(outcome.r.error).not.toBeNull()
      expect(outcome.r.error!.kind).toBe('abort')
    }
    // `patient` is deliberately left pending forever in this test (nothing
    // ever settles the shared operation) — a safety net against an
    // unhandled-rejection warning, not a real assertion.
    patient.catch(() => {})
  })

  it('share: true, already aborted at call time, never rejects', async () => {
    const fn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal | undefined
      if (s?.aborted) { rej(s.reason); return }
      s?.addEventListener('abort', () => rej(s.reason))
    }))
    vi.stubGlobal('fetch', fn)
    const ac = new AbortController()
    ac.abort(hostileReason())
    const api = createApi({
      baseUrl: '',
      requests: { g: new Request<{ id: string }, unknown>({ method: 'GET', path: '/g/:id', share: true }) },
    })
    const r = await api.g({ id: '1' }, { signal: ac.signal })
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('abort')
  })

  it('unshared, a middleware rethrows signal.reason verbatim, never rejects', async () => {
    const rethrows: Middleware = ctx => new Promise((_resolve, reject) => {
      const s = ctx.request.signal
      if (s?.aborted) { reject(s.reason); return }
      s?.addEventListener('abort', () => reject(s.reason), { once: true })
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const ac = new AbortController()
    const api = createApi({
      baseUrl: '', middleware: [rethrows],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    const p = api.g({}, { signal: ac.signal })
    ac.abort(hostileReason())
    const r = await p
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('abort')
  })

  it('unshared, no middleware at all — the core() fetch-catch itself, never rejects', async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const s = init.signal as AbortSignal | undefined
      if (s?.aborted) { rej(s.reason); return }
      s?.addEventListener('abort', () => rej(s.reason))
    }))
    vi.stubGlobal('fetch', hang)
    const ac = new AbortController()
    const api = createApi({
      baseUrl: '',
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
    })
    const p = api.g({}, { signal: ac.signal })
    ac.abort(hostileReason())
    const r = await p
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('abort')
  })
})

// GraphQL never coalesces (createGraphQL has no `share` concept — see the
// comment in graphql.ts's execute()), so there is no shared-path variant
// here, only the two create-api.ts also has: an async throw and a
// synchronous throw. `graphql.ts` has its own local `buildFailedResult`
// equivalent and its own composed(context) call site, so this is a separate
// discriminating pin, not a duplicate of the REST suite above.
describe('a throwing middleware never rejects a GraphQL caller', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":{}}', { status: 200 }))) })
  afterEach(() => { vi.restoreAllMocks() })

  it('an async throw returns a Result', async () => {
    const api = createGraphQL({
      endpoint: '/graphql',
      middleware: [boom],
      operations: { g: new Operation<Record<string, never>, unknown>({ operation: 'query { g }' }) },
    })
    const r = await api.g()
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('middleware')
    expect(String((r.error!.body as Error).message)).toContain('middleware exploded')
  })

  it('a synchronous throw also returns a Result', async () => {
    const sync: Middleware = () => { throw new Error('sync boom') }
    const api = createGraphQL({
      endpoint: '/graphql',
      middleware: [sync],
      operations: { g: new Operation<Record<string, never>, unknown>({ operation: 'query { g }' }) },
    })
    expect((await api.g()).error!.kind).toBe('middleware')
  })

  it('reports the middleware failure to onError exactly once', async () => {
    const kinds: string[] = []
    const api = createGraphQL({
      endpoint: '/graphql',
      middleware: [boom],
      onError: (e: ApiError) => { kinds.push(e.kind) },
      operations: { g: new Operation<Record<string, never>, unknown>({ operation: 'query { g }' }) },
    })
    await api.g()
    await new Promise(r => setTimeout(r, 20))
    expect(kinds).toEqual(['middleware'])
  })

  // Twin of the REST suite's identical test above — graphql.ts has its own
  // local `buildFailedResult` call site that also feeds `propagatesReason`.
  it('a middleware throwing an object with a throwing .cause getter never rejects the caller', async () => {
    const evilCause: Middleware = async () => {
      const err = new Error('boom')
      Object.defineProperty(err, 'cause', { get() { throw new TypeError('boom from cause getter') } })
      throw err
    }
    const ac = new AbortController()
    ac.abort()
    const api = createGraphQL({
      endpoint: '/graphql',
      middleware: [evilCause],
      operations: { g: new Operation<Record<string, never>, unknown>({ operation: 'query { g }' }) },
    })
    const r = await api.g(undefined, { signal: ac.signal })
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('middleware')
  })

  // Twin of the REST suite's "abortKind's .name read" tests above —
  // graphql.ts's own `buildFailedResult` call site feeds `abortKind` too.
  // GraphQL has no `share` concept, so only the unshared-rethrow shape
  // applies here.
  it("a middleware rethrowing signal.reason with a hostile .name getter never rejects", async () => {
    const hostileReason: { name: string } = {} as { name: string }
    Object.defineProperty(hostileReason, 'name', { get() { throw new TypeError('hostile name getter') } })
    const rethrows: Middleware = ctx => new Promise((_resolve, reject) => {
      const s = ctx.request.signal
      if (s?.aborted) { reject(s.reason); return }
      s?.addEventListener('abort', () => reject(s.reason), { once: true })
    })
    const ac = new AbortController()
    const api = createGraphQL({
      endpoint: '/graphql',
      middleware: [rethrows],
      operations: { g: new Operation<Record<string, never>, unknown>({ operation: 'query { g }' }) },
    })
    const p = api.g(undefined, { signal: ac.signal })
    ac.abort(hostileReason)
    const r = await p
    expect(r.error).not.toBeNull()
    expect(r.error!.kind).toBe('abort')
  })
})
