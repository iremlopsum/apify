import { describe, it, expect } from 'vitest'
import { buildUrl } from '../src/utils/path-params.js'
import { createApi } from '../src/create-api.js'
import { defineRequest } from '../src/define-request.js'
import { Request } from '../src/request.js'
import { vi, afterEach } from 'vitest'

/**
 * Each row is a path and the params the TYPE-LEVEL parser infers for it (see
 * tests/types.test-d.ts, which pins the same key sets at compile time).
 *
 * buildUrl ends a token at the first character outside [a-zA-Z0-9_]
 * (src/utils/path-params.ts, the `:${key}(?=[^a-zA-Z0-9_]|$)` pattern). A
 * type-level parser that split on '/' instead would infer `id.json` for
 * `/users/:id.json`; the consumer would then pass a key buildUrl cannot
 * substitute, `:id` would survive, and buildUrl THROWS on a leftover token.
 * This test is what stops the two rules diverging.
 */
const cases: Array<[path: string, params: Record<string, string | number>, url: string]> = [
  ['/users/:id',              { id: 42 },                          '/users/42'],
  ['/orgs/:org/repos/:repo',  { org: 'acme', repo: 'x' },          '/orgs/acme/repos/x'],
  ['/health',                 {},                                  '/health'],
  ['/orgs/:id/members/:id',   { id: 7 },                           '/orgs/7/members/7'],
  ['/users/:id.json',         { id: 42 },                          '/users/42.json'],
  ['/a/:id-b',                { id: 42 },                          '/a/42-b'],
  ['/users/:id_v2',           { id_v2: 9 },                        '/users/9'],
  ['/a/:one/b/:two/c/:three', { one: 1, two: 2, three: 3 },        '/a/1/b/2/c/3'],
  ['/search/:q?x=1',          { q: 'hi' },                         '/search/hi?x=1'],
]

describe('the type-level parser agrees with buildUrl', () => {
  it.each(cases)('%s', (path, params, url) => {
    const out = buildUrl('', path, params, false)
    expect(out.url).toBe(url)
    // Every key the type declares must be CONSUMED by substitution. A key left
    // in `remaining` means the type named a param the path does not have.
    expect(Object.keys(out.remaining)).toEqual([])
  })
})

describe('defineRequest at runtime', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('builds the same URL as an equivalent new Request', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { seen.push(u); return new Response('{"ok":1}', { status: 200 }) }))
    const api = createApi({
      baseUrl: 'https://api.test',
      requests: {
        viaFactory: defineRequest<{ ok: number }>()({ method: 'GET', path: '/users/:id' }),
        viaClass: new Request<{ id: string }, { ok: number }>({ method: 'GET', path: '/users/:id' }),
      },
    })
    const viaFactoryResult = await api.viaFactory({ id: '42' })
    const viaClassResult = await api.viaClass({ id: '42' })
    expect(seen[0]).toBe('https://api.test/users/42')
    expect(seen[0]).toBe(seen[1])
    expect(viaFactoryResult.error).toBeNull()
    expect(viaClassResult.error).toBeNull()
    expect(viaFactoryResult.data).toEqual({ ok: 1 })
    expect(viaFactoryResult.data).toEqual(viaClassResult.data)
  })

  it('substitutes and encodes a numeric path param', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { seen.push(u); return new Response('{"ok":1}', { status: 200 }) }))
    const api = createApi({
      baseUrl: 'https://api.test',
      requests: { get: defineRequest<{ ok: number }>()({ method: 'GET', path: '/users/:id' }) },
    })
    const r = await api.get({ id: 42 })
    expect(seen[0]).toBe('https://api.test/users/42')
    expect(r.error).toBeNull()
  })
})
