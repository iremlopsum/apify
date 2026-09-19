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

/**
 * Flushes the entire microtask queue: a macrotask only runs once every pending
 * microtask has drained, so this guarantees any report still in flight through
 * a promise chain has fired before we assert on it.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * A fetch that never settles until told to, and rejects if its signal aborts.
 * Copied from tests/share.test.ts rather than shared — each unit test file in
 * this repo defines its own fetch helpers.
 */
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

const sharedApi = () => createApi({
  baseUrl: 'https://api.test',
  requests: {
    getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id', share: true }),
  },
})

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

describe('error.request.url for a fragment-bearing baseUrl', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const fragged = () => createApi({
    baseUrl: 'https://api.test/v1#f',
    requests: {
      listItems: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' }),
      getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:id' }),
    },
  })

  // 4.2.1 made buildUrl refuse a fragment, which sends urlForError down its
  // joinUrl fallback. Until 4.4.0 that fallback concatenated, leaving the
  // fragment mid-string: 'https://api.test/v1#f' + '/items' gave
  // '.../v1#f/items', which parses to pathname '/v1' -- naming an endpoint the
  // call was never for. Diagnostic only, but it is the same class of mangled
  // output 4.2.1 removed from the request path, and a report that resolves
  // somewhere else is worse than no report.
  it('reports a URL whose pathname is the endpoint that was asked for', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await fragged().listItems({})

    expect(r.error).not.toBeNull()
    // Asserting the PARSE, not the spelling: the old string looked plausible
    // and resolved wrongly, which is exactly how this survived review once.
    expect(new URL(r.error!.request.url).pathname).toBe('/v1/items')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('keeps the offending fragment visible, in the place a URL puts one', async () => {
    // Not stripped: the error message names the fragment, and the URL shows it
    // where a URL carries one, so the two agree instead of contradicting.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await fragged().listItems({})

    expect(r.error?.request.url).toBe('https://api.test/v1/items#f')
    // The thrown TypeError rides in `body` -- ApiError does not extend Error,
    // so there is no `.message` to read it from.
    expect(String(r.error?.body)).toMatch(/#f/)
  })

  it('still reports the raw path template when the path has params -- known gap', async () => {
    // NOT what this release fixes, and pinned so the gap is visible rather than
    // discovered again. urlForError falls back to joinUrl(baseUrl, config.path)
    // -- the RAW template -- because buildUrl threw in Phase 0, before any
    // substitution ran. For a nested-query-object failure that is the only
    // honest answer (see the block above), but a fragment does not prevent
    // substitution, so ':id' here is lossier than it needs to be. Fixing it
    // means letting Phase 0 run after substitution, which is a change to
    // buildUrl's shape, not to joinUrl's. See BACKLOG 2.7.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await fragged().getUser({ id: '42' })

    expect(r.error?.request.url).toBe('https://api.test/v1/users/:id#f')
    // The part 4.4.0 DOES guarantee, even here: it parses to the right prefix
    // and the fragment is at the end.
    expect(new URL(r.error!.request.url).hash).toBe('#f')
  })
})

describe('share: true callers agree with each other', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a joiner and the initiator report the same URL when both give up', async () => {
    // Pinned as agreement, deliberately separate from the literal-value
    // assertions elsewhere in this file: agreement alone would still pass if
    // both sides regressed to the template together. It fails if only one of
    // the two learns the real URL — which is what a closure-captured URL
    // produces, since a joiner never runs its own execute().
    const f = controllable()
    vi.stubGlobal('fetch', f.fn)
    const shared = sharedApi()
    const a = new AbortController()
    const b = new AbortController()
    const initiator = shared.getUser({ id: '42' }, { signal: a.signal })
    const joiner = shared.getUser({ id: '42' }, { signal: b.signal })
    await flush()
    expect(f.fn.mock.calls.length).toBe(1)
    b.abort()
    const jr = await joiner
    a.abort()
    const ir = await initiator
    expect(jr.error?.kind).toBe('abort')
    expect(ir.error?.kind).toBe('abort')
    expect(jr.error?.request.url).toBe(ir.error?.request.url)
  })
})

describe('error.request.url on the share give-up path', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reports the resolved URL for a joiner that gives up', async () => {
    const f = controllable()
    vi.stubGlobal('fetch', f.fn)
    const shared = sharedApi()
    const a = new AbortController()
    const b = new AbortController()
    const initiator = shared.getUser({ id: '42' }, { signal: a.signal })
    const joiner = shared.getUser({ id: '42' }, { signal: b.signal })
    await flush()
    b.abort()
    const jr = await joiner
    a.abort()
    await initiator
    expect(jr.error?.kind).toBe('abort')
    expect(jr.error?.request.url).toBe('https://api.test/users/42')
  })

  it('reports the resolved URL for the initiator that gives up', async () => {
    const f = controllable()
    vi.stubGlobal('fetch', f.fn)
    const shared = sharedApi()
    const a = new AbortController()
    const b = new AbortController()
    const initiator = shared.getUser({ id: '42' }, { signal: a.signal })
    const joiner = shared.getUser({ id: '42' }, { signal: b.signal })
    await flush()
    a.abort()
    const ir = await initiator
    b.abort()
    await joiner
    expect(ir.error?.kind).toBe('abort')
    expect(ir.error?.request.url).toBe('https://api.test/users/42')
  })
})

describe('error.request.url when setup threw before the URL was built', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // A BigInt timeout is the cheapest reachable setup failure: TypeScript
  // forbids it, JavaScript callers and `as any` config loaders do not, and it
  // reaches Math.min inside timeoutSignalFor. Both budget calls that use it run
  // BEFORE the URL is ever built — operationBudget at Step 2 for an unshared
  // call, perCallerBudget before acquire() for a shared one. Neither request
  // resolved a URL for itself; both can still name the one it was for, which is
  // what error.request.url documents.
  it('reports the resolved URL for an unshared call', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const r = await api([]).getUser({ id: '42' }, { timeout: 10n as unknown as number })
    expect(r.error).not.toBeNull()
    expect(r.error?.request.url).toBe('https://api.test/users/42')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports the resolved URL when the share block itself threw', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const r = await sharedApi().getUser({ id: '42' }, { timeout: 10n as unknown as number })
    expect(r.error).not.toBeNull()
    expect(r.error?.request.url).toBe('https://api.test/users/42')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('error.request.url when a middleware rethrows the signal reason', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // Pins the CHANGELOG's 4.0.2 "ordinary aborts were already correct"
  // paragraph for the one example whose mechanism it misstated: this
  // rejection never reaches core()'s fetch catch, because the middleware
  // never calls next() — it races the caller's signal instead, so the call
  // is left pending ("mid-flight") until the abort fires. The rejection
  // escapes composed(context) and is caught by Step 8's 'middleware' catch,
  // which passes context.request.url explicitly, then propagatesReason
  // reclassifies it to 'abort' inside syntheticResult.
  it('reports the resolved URL, not the template, on an ordinary caller abort', async () => {
    const rethrows: Middleware = ctx => new Promise((_resolve, reject) => {
      const s = ctx.request.signal
      if (s?.aborted) { reject(s.reason); return }
      s?.addEventListener('abort', () => reject(s.reason), { once: true })
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const ac = new AbortController()
    const p = api([rethrows]).getUser({ id: '42' }, { signal: ac.signal })
    await flush()
    ac.abort()
    const r = await p
    expect(r.error?.kind).toBe('abort')
    expect(r.error?.request.url).toBe('https://api.test/users/42')
  })
})
