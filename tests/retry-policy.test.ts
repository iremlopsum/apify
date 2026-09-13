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
})
