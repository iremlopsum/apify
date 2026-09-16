import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { Middleware } from '../src/types.js'

const api = (middleware: Middleware[]) => createApi({
  baseUrl: 'https://api.test',
  middleware,
  requests: {
    getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id' }),
  },
})

const throwing: Middleware = async () => { throw new Error('middleware exploded') }

describe('error.request.url on a middleware failure', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reports the path-substituted URL, not the route template', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await api([throwing]).getUser({ id: '42' })
    expect(r.error?.kind).toBe('middleware')
    expect(r.error?.request.url).toBe('https://api.test/users/42')
  })

  it('does not report the raw template', async () => {
    // The defect this task fixes: `:id` reaching a consumer's telemetry.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await api([throwing]).getUser({ id: '42' })
    expect(r.error?.request.url).not.toContain(':id')
  })

  it('matches what the http error path reports for the same call', async () => {
    // The whole point: every error path should name the same address.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const httpErr = await api([]).getUser({ id: '42' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const mwErr = await api([throwing]).getUser({ id: '42' })
    expect(mwErr.error?.request.url).toBe(httpErr.error?.request.url)
  })
})

describe('error.request.url when the URL could never be built', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('falls back to the template when buildUrl itself threw', async () => {
    // A nested object in a query string makes buildUrl throw a TypeError --
    // the library deliberately refuses to pick a serialization convention.
    // There is no resolved URL to report here, so the template is the only
    // honest answer and must survive this change.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const nested = createApi({
      baseUrl: 'https://api.test',
      requests: {
        search: new Request<Record<string, unknown>, unknown>({ method: 'GET', path: '/search' }),
      },
    })
    const r = await nested.search({ filter: { nested: true } })
    expect(r.error).not.toBeNull()
    expect(r.error?.request.url).toBe('https://api.test/search')
  })
})

describe('share: true callers agree with each other', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a joiner and the initiator report the same URL when both give up', async () => {
    // Pinned as agreement, not as a literal value: this must hold whether both
    // report the template (today) or both report the resolved URL (if the
    // abort path is ever fixed properly, which needs a ShareTracker change).
    // It fails if only one of the two learns the real URL.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r =>
      setTimeout(() => r(new Response('{}', { status: 200 })), 300)
    )))
    const shared = createApi({
      baseUrl: 'https://api.test',
      requests: {
        getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id', share: true }),
      },
    })
    const a = new AbortController()
    const b = new AbortController()
    const initiator = shared.getUser({ id: '42' }, { signal: a.signal })
    await new Promise(r => setTimeout(r, 20))
    const joiner = shared.getUser({ id: '42' }, { signal: b.signal })
    await new Promise(r => setTimeout(r, 20))
    b.abort()
    const jr = await joiner
    a.abort()
    const ir = await initiator
    expect(jr.error?.kind).toBe('abort')
    expect(ir.error?.kind).toBe('abort')
    expect(jr.error?.request.url).toBe(ir.error?.request.url)
  })
})
