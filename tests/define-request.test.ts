import { describe, it, expect } from 'vitest'
import { buildUrl } from '../src/utils/path-params.js'

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
