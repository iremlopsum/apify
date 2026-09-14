import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { retryMiddleware } from '../src/built-in-middleware.js'

const always = (status: number, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response('e', { status, headers }))

const makeApi = (mw: ReturnType<typeof retryMiddleware>) => createApi({
  baseUrl: '', middleware: [mw],
  requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g' }) },
})

describe('retry policy', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('keeps the numeric signature working', async () => {
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware(2)).g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('actually waits between attempts', async () => {
    vi.stubGlobal('fetch', always(503))
    const started = Date.now()
    await makeApi(retryMiddleware({ max: 2, baseDelay: 40, jitter: false })).g()
    expect(Date.now() - started).toBeGreaterThanOrEqual(100) // 40 + 80, allowing slack
  })

  it('keeps jitter within [0, computed]', async () => {
    const delays: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 3, baseDelay: 100, jitter: true,
      onRetry: ({ delay }) => { delays.push(delay) },
    })).g()
    expect(delays.length).toBe(3)
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(100 * 2 ** i)
    })
  })

  it('honours Retry-After in delta-seconds', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503, { 'retry-after': '1' }))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 10_000, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen[0]).toBe(1000)
  })

  it('honours Retry-After as an HTTP date', async () => {
    const seen: number[] = []
    const when = new Date(Date.now() + 2000).toUTCString()
    vi.stubGlobal('fetch', always(503, { 'retry-after': when }))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 10_000, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen[0]).toBeGreaterThan(500)
    expect(seen[0]).toBeLessThanOrEqual(2000)
  })

  it('falls back to the computed delay for an unparseable Retry-After', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503, { 'retry-after': 'soonish' }))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 30, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen[0]).toBe(30)
  })

  it('caps a delay at maxDelay', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503, { 'retry-after': '3600' }))
    await makeApi(retryMiddleware({
      max: 1, maxDelay: 50, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen[0]).toBe(50)
  })

  it('does not retry 4xx by default', async () => {
    vi.stubGlobal('fetch', always(404))
    await makeApi(retryMiddleware({ max: 3, baseDelay: 1 })).g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('retries what retryOn says to, with the attempt number', async () => {
    const attempts: number[] = []
    vi.stubGlobal('fetch', always(429))
    await makeApi(retryMiddleware({
      max: 2, baseDelay: 1,
      retryOn: (r, attempt) => { attempts.push(attempt); return r.error?.status === 429 },
    })).g()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('survives a throwing onRetry', async () => {
    vi.stubGlobal('fetch', always(503))
    const r = await makeApi(retryMiddleware({
      max: 1, baseDelay: 1,
      onRetry: () => { throw new Error('logger exploded') },
    })).g()
    expect(r.error!.status).toBe(503)
  })

  it('survives a throwing retryOn', async () => {
    vi.stubGlobal('fetch', always(503))
    // The natural, unguarded predicate (`r => r.error.status >= 500`, no
    // optional chaining) throws on every success, where `r.error` is null —
    // this must resolve with a Result, not reject the call.
    const r = await makeApi(retryMiddleware({
      max: 3, baseDelay: 1,
      retryOn: () => { throw new Error('predicate exploded') },
    })).g()
    // Can't know whether to retry, so we stop: the caller gets the first
    // failure rather than looping past an unknown.
    expect(r.error!.status).toBe(503)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('survives a throwing delay curve', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    const r = await makeApi(retryMiddleware({
      max: 1, baseDelay: 20, jitter: false,
      delay: () => { throw new Error('curve boom') },
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    // Falls back to the exponential default (baseDelay * 2**(attempt-1),
    // i.e. 20 for attempt 1) rather than propagating.
    expect(seen[0]).toBe(20)
    expect(r.error!.status).toBe(503)
  })

  it('treats a whitespace-only Retry-After as absent', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503, { 'retry-after': '   ' }))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 30, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    // Number('   ') coerces to 0 — without trimming first, that reads as a
    // valid "retry immediately" instead of falling through to the computed
    // delay.
    expect(seen[0]).toBe(30)
  })

  it('ignores Retry-After when respectRetryAfter is false', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503, { 'retry-after': '1' }))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 40, jitter: false, respectRetryAfter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen[0]).toBe(40)
  })

  it('uses a custom delay curve when provided', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 3, jitter: false,
      delay: attempt => attempt * 7,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen).toEqual([7, 14, 21])
  })

  it('stops promptly when the deadline fires during backoff', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const s = init.signal as AbortSignal | undefined
      if (s?.aborted) throw s.reason
      return new Response('e', { status: 503 })
    }))
    const api = createApi({
      baseUrl: '', middleware: [retryMiddleware({ max: 5, baseDelay: 10_000, jitter: false })],
      requests: { g: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/g', timeout: 50 }) },
    })
    const started = Date.now()
    const r = await api.g()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.error).not.toBeNull()
    // The loop must call next() with the aborted signal rather than return
    // the stale 503 — otherwise the caller could never tell the deadline
    // fired at all (this is what task 3's `kind` discriminator is for).
    expect(r.error?.kind).toBe('timeout')
  })

  // ---------------------------------------------------------------------------
  // The backoff sleep registers an abort listener on ctx.request.signal so a
  // whole-operation deadline can cut it short. Without the removal on the
  // timer-elapsed path, a long retry sequence leaves one dead listener per
  // attempt on a signal that often outlives the request — and nothing else
  // about the behaviour changes, so only watching for the removal catches it.
  // ---------------------------------------------------------------------------
  it('releases the backoff sleep listener when the delay elapses', async () => {
    vi.stubGlobal('fetch', always(503))
    const ac = new AbortController()
    const spy = vi.spyOn(ac.signal, 'removeEventListener')

    await makeApi(retryMiddleware({ max: 2, baseDelay: 5, jitter: false })).g({}, { signal: ac.signal })

    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
    spy.mockRestore()
  })

  it('releases the backoff sleep listener when the signal aborts mid-delay', async () => {
    vi.stubGlobal('fetch', always(503))
    const ac = new AbortController()
    const spy = vi.spyOn(ac.signal, 'removeEventListener')

    const p = makeApi(retryMiddleware({ max: 2, baseDelay: 2000, jitter: false })).g({}, { signal: ac.signal })
    await new Promise(r => setTimeout(r, 20))
    ac.abort()
    await p

    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
    spy.mockRestore()
  })
  // ---------------------------------------------------------------------------
  // A custom curve is arithmetic a consumer wrote, so it can return NaN (a
  // stray undefined in the expression) or a negative (a sign error) just as
  // easily as it can throw — and neither is caught by try/catch. Both reach
  // setTimeout, where they mean "fire immediately": a backoff policy silently
  // becomes a tight retry loop against a server that is already struggling.
  // ---------------------------------------------------------------------------
  it('falls back to the exponential curve when a custom delay returns NaN', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 2, baseDelay: 10, jitter: false,
      delay: () => Number.NaN,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen).toEqual([10, 20])
  })

  it('clamps a negative custom delay to zero', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: 10, jitter: false,
      delay: () => -500,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen).toEqual([0])
  })

  // ---------------------------------------------------------------------------
  // Fix 5 (2.2.1): `maxDelay` only ever got a `??` default, so an explicit
  // `NaN` (as consumer-supplied as baseDelay or a custom curve — a stray
  // `Number(process.env.X)`) survived into `Math.min(computed, maxDelay)`,
  // which is NaN whenever either argument is. The existing backstop then
  // clamped that NaN to 0 — turning the whole backoff policy into a tight
  // retry burst against a server that is already struggling, exactly what
  // the feature exists to prevent. `maxDelay` must fall back to its default
  // instead of poisoning the arithmetic.
  // ---------------------------------------------------------------------------
  it('falls back to the default maxDelay when given NaN, instead of collapsing backoff to zero', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 2, baseDelay: 10, jitter: false,
      maxDelay: Number.NaN,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    // Uncapped exponential delays (10, 20) — both comfortably under the
    // default maxDelay (30_000) — not [0, 0].
    expect(seen).toEqual([10, 20])
  })

  // baseDelay is exactly as consumer-supplied as maxDelay, and poisons the
  // same Math.min(computed, maxDelay) arithmetic the same way (NaN * 2 ** n
  // is NaN), so it gets the identical validate-or-default treatment.
  it('falls back to the default baseDelay when given NaN', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', always(503))
    await makeApi(retryMiddleware({
      max: 1, baseDelay: Number.NaN, jitter: false,
      onRetry: ({ delay }) => { seen.push(delay) },
    })).g()
    expect(seen).toEqual([250])
  })
})
