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
})
