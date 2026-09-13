// =============================================================================
// dedupe-signal.test.ts — dedupe's interaction with ctx.request.signal
// =============================================================================
//
// Dedupe registration happens inside core(), so that a middleware which
// short-circuits (a cache hit) never cancels a live request. These tests pin
// down the two things that registration point must get right:
//
// 1. It must run ONCE per execute(), not once per attempt. retryMiddleware
//    calls next() repeatedly; if each attempt re-registered, an older
//    request's retry would abort a newer request for the same endpoint —
//    inverting dedupe's newest-wins contract.
//
// 2. It must treat a signal installed by middleware as an INPUT, not as
//    something to discard. A timeout middleware sets ctx.request.signal
//    before core runs; dedupe has to merge that signal rather than replace
//    it, or the timeout silently stops working under dedupe: true.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { retryMiddleware } from '../src/built-in-middleware.js'
import type { Middleware, Result } from '../src/types.js'

// ---------------------------------------------------------------------------
// A fetch mock whose every call is settled by hand.
//
// Each call is recorded with its signal and its resolve/reject handles, so a
// test can decide exactly when (and in which order) attempts come back. The
// mock mirrors real fetch on two points that matter here:
//   - an already-aborted signal rejects immediately
//   - an abort that arrives later rejects the in-flight promise
// ---------------------------------------------------------------------------
interface FetchCall {
  url: string
  signal: AbortSignal | undefined
  resolve: (response: Response) => void
  aborted: () => boolean
}

function controllableFetch() {
  const calls: FetchCall[] = []

  const fn = vi.fn((url: string, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal | undefined
    return new Promise<Response>((resolve, reject) => {
      calls.push({
        url,
        signal,
        resolve,
        aborted: () => signal?.aborted ?? false
      })

      const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  })

  return { fn, calls }
}

/** Let the microtask queue (and any 0ms timers) drain. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('dedupe + ctx.request.signal', () => {
  let f: ReturnType<typeof controllableFetch>

  beforeEach(() => {
    f = controllableFetch()
    vi.stubGlobal('fetch', f.fn)
  })

  afterEach(() => vi.restoreAllMocks())

  // ---------------------------------------------------------------------------
  // 1. Supersede ordering: an older request's retry must not abort a newer call
  // ---------------------------------------------------------------------------
  it("an older request's retry does not abort a newer request", async () => {
    const search = new Request<{ q: string }, unknown>({ method: 'GET', path: '/search', dedupe: true })
    const api = createApi({ baseUrl: '', requests: { search } })

    // A is the older call, and the only one carrying retry middleware — B's
    // chain stays bare so the two retry sequences cannot tangle.
    const pA = api.search({ q: 'a' }, { middleware: [retryMiddleware(2)] }) as Promise<Result<unknown>>
    await tick()
    expect(f.calls).toHaveLength(1)

    // A's first attempt comes back 503. retryMiddleware will retry it, but the
    // retry is queued on the microtask queue and has not run yet.
    f.calls[0].resolve(new Response('boom', { status: 503 }))

    // B — a genuinely newer call for the same endpoint — starts in the same
    // tick, before A's retry reaches core(). Registration is synchronous, so
    // B owns the dedupe lane from this line onward.
    const pB = api.search({ q: 'b' }) as Promise<Result<unknown>>
    expect(f.calls).toHaveLength(2)

    // Let A's retry run.
    await tick()
    await tick()

    // The contract: newest wins. B must still be live.
    expect(f.calls[1].aborted()).toBe(false)

    // Settle whatever is still in flight, then compare outcomes.
    for (let i = 1; i < f.calls.length; i++) {
      f.calls[i].resolve(new Response('{"ok":true}', { status: 200 }))
    }

    const rB = await pB
    const rA = await pA

    // B survives...
    expect(rB.error).toBeNull()
    expect(rB.data).toEqual({ ok: true })

    // ...and A loses: it was superseded, so its retry is cancelled too.
    expect(rA.error).not.toBeNull()
    expect(rA.error?.status).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 2. A middleware-installed timeout still fires under dedupe: true
  // ---------------------------------------------------------------------------
  it('honours a timeout signal installed by middleware', async () => {
    const slow = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/slow', dedupe: true })

    const timeout = (ms: number): Middleware => async (ctx, next) => {
      ctx.request.signal = AbortSignal.timeout(ms)
      return next()
    }

    const api = createApi({ baseUrl: '', requests: { slow }, middleware: [timeout(30)] })

    // The fetch mock never resolves on its own — only an abort settles it. If
    // dedupe discards the middleware's signal the call hangs, so race it
    // against a guard timer rather than letting the suite time out.
    const outcome = await Promise.race([
      api.slow() as Promise<Result<unknown>>,
      new Promise<'HUNG'>(resolve => setTimeout(() => resolve('HUNG'), 500))
    ])

    expect(outcome).not.toBe('HUNG')
    expect((outcome as Result<unknown>).error?.status).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 3. The three-way: dedupe + a signal-replacing middleware + retry
  // ---------------------------------------------------------------------------
  it('retries under a signal-replacing middleware without self-aborting', async () => {
    const flaky = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/flaky', dedupe: true })

    // Outermost, so it installs its signal once and retry re-enters only core.
    const replaceSignal: Middleware = async (ctx, next) => {
      ctx.request.signal = new AbortController().signal
      return next()
    }

    const api = createApi({
      baseUrl: '',
      requests: { flaky },
      middleware: [replaceSignal, retryMiddleware(2)]
    })

    const p = api.flaky() as Promise<Result<unknown>>
    await tick()
    expect(f.calls).toHaveLength(1)

    f.calls[0].resolve(new Response('boom', { status: 503 }))
    await tick()

    // The retry must actually reach the network, on a signal nobody aborted.
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1].aborted()).toBe(false)

    f.calls[1].resolve(new Response('{"ok":true}', { status: 200 }))
    const result = await p

    expect(result.error).toBeNull()
    expect(result.data).toEqual({ ok: true })
  })
})
