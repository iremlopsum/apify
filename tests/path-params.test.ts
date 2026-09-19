// =============================================================================
// path-params.test.ts — Tests for URL building, path param substitution, and
// query string serialization
// =============================================================================
//
// The buildUrl function handles three responsibilities:
// 1. Substituting `:param` tokens in URL paths with actual values
// 2. Separating "consumed" path params from "remaining" params
// 3. Optionally serializing remaining params as a query string
//
// These tests cover edge cases like:
// - URI encoding of special characters in path params
// - Multiple path params in one URL
// - Array values in query strings (repeated keys)
// - null/undefined omission from query strings
// - Nested object rejection (not supported, must flatten first)
// - Partial param name matching prevention (:id vs :idExtra)
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildUrl } from '../src/utils/path-params.js'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

describe('buildUrl', () => {
  it('returns base + path with no params', () => {
    // Simplest case — no params, no substitution, just concatenation
    const { url, remaining } = buildUrl('/api', '/items', {})
    expect(url).toBe('/api/items')
    expect(remaining).toEqual({})
  })

  it('substitutes path params and excludes them from remaining', () => {
    // :id should be replaced with '42', and 'extra' stays in remaining
    // because it doesn't match any path param token
    const { url, remaining } = buildUrl('/api', '/items/:id', { id: '42', extra: 'yes' })
    expect(url).toBe('/api/items/42')
    expect(remaining).toEqual({ extra: 'yes' })
  })

  it('encodes path param values', () => {
    // Special characters in path params must be URI-encoded to produce valid URLs
    const { url } = buildUrl('/api', '/items/:id', { id: 'hello world' })
    expect(url).toBe('/api/items/hello%20world')
  })

  it('substitutes multiple path params', () => {
    // Multiple :param tokens in a single path — both should be replaced,
    // and non-matching params should remain
    const { url, remaining } = buildUrl('', '/orgs/:org/repos/:repo', {
      org: 'acme',
      repo: 'lib',
      page: 1
    })
    expect(url).toBe('/orgs/acme/repos/lib')
    expect(remaining).toEqual({ page: 1 })
  })

  it('appends query string for GET-style params', () => {
    // When asQuery=true, remaining params are serialized as ?key=value pairs
    const { url } = buildUrl('/api', '/items', { page: 1, limit: 20 }, true)
    expect(url).toBe('/api/items?page=1&limit=20')
  })

  it('handles arrays with repeated keys in query string', () => {
    // Arrays use repeated keys: tags=a&tags=b (not tags[]=a)
    // This is the most widely supported format across web servers
    const { url } = buildUrl('/api', '/items', { tags: ['a', 'b'] }, true)
    expect(url).toBe('/api/items?tags=a&tags=b')
  })

  it('omits null and undefined values from query string', () => {
    // null and undefined params should be silently omitted, not serialized
    // as "filter=null" or "sort=undefined"
    const { url } = buildUrl('/api', '/items', { page: 1, filter: null, sort: undefined }, true)
    expect(url).toBe('/api/items?page=1')
  })

  it('throws TypeError for nested objects in query string', () => {
    // Nested objects can't be meaningfully serialized as query strings without
    // a convention (brackets, dots, etc.). We throw to force the caller to
    // flatten the data first, avoiding ambiguity.
    expect(() => buildUrl('/api', '/items', { nested: { a: 1 } }, true)).toThrow(TypeError)
  })

  it('does not append query string when asQuery is false', () => {
    // When asQuery=false (the default), remaining params stay in `remaining`
    // and the URL has no query string — the caller handles serialization
    // (typically as a request body for POST/PUT/PATCH)
    const { url, remaining } = buildUrl('/api', '/items', { page: 1 }, false)
    expect(url).toBe('/api/items')
    expect(remaining).toEqual({ page: 1 })
  })

  it('returns empty remaining when asQuery consumes all params', () => {
    // When asQuery=true, ALL remaining params are consumed into the query string,
    // so `remaining` should be an empty object
    const { url, remaining } = buildUrl('/api', '/items', { page: 1, limit: 20 }, true)
    expect(url).toBe('/api/items?page=1&limit=20')
    expect(remaining).toEqual({})
  })

  it('does not match partial param names (e.g. :id inside :idExtra)', () => {
    // CRITICAL: A naive string replace of `:id` would also match inside `:idExtra`.
    // We use regex word-boundary matching to prevent this — `:id` should only match
    // when followed by a non-word character or end of string.
    const { url, remaining } = buildUrl('', '/items/:idExtra', { id: '42', idExtra: 'foo' })
    expect(url).toBe('/items/foo')
    expect(remaining).toEqual({ id: '42' })
  })

  it('substitutes every occurrence of a repeated token', () => {
    // A template may legitimately name the same param twice. Without the `g`
    // flag only the first was substituted, and the survivor then tripped the
    // unresolved-token check — a working path turned into a hard throw.
    const { url, remaining } = buildUrl('', '/orgs/:id/members/:id', { id: '42' })
    expect(url).toBe('/orgs/42/members/42')
    expect(remaining).toEqual({})
  })

  it('does not throw on a repeated token', () => {
    expect(() => buildUrl('/api', '/a/:id/b/:id', { id: '1' })).not.toThrow()
  })
})

describe('unresolved path params', () => {
  it('throws when a :token has no matching param', () => {
    expect(() => buildUrl('/api', '/users/:userId', { id: '42' }, true))
      .toThrow(TypeError)
  })

  it('names the offending token in the message', () => {
    expect(() => buildUrl('/api', '/users/:userId', { id: '42' }, true))
      .toThrow(/:userId/)
  })

  it('reports every unresolved token, not just the first', () => {
    expect(() => buildUrl('/api', '/orgs/:org/repos/:repo', {}, true))
      .toThrow(/:org.*:repo|:repo.*:org/)
  })

  it('does not throw when every token is substituted', () => {
    expect(() => buildUrl('/api', '/orgs/:org/repos/:repo', { org: 'a', repo: 'b' }))
      .not.toThrow()
  })

  it('does not mistake a bare colon in a path for a param token', () => {
    expect(() => buildUrl('/api', '/time/12:30', {})).not.toThrow()
  })

  it('detects a token whose name starts with a digit', () => {
    expect(() => buildUrl('/api', '/promo/:2fa', {}, true)).toThrow(/:2fa/)
  })

  it('detects a token whose name is only digits', () => {
    expect(() => buildUrl('/api', '/v/:2', {}, true)).toThrow(/:2/)
  })
})

describe('baseUrl and path joining', () => {
  it('collapses a double slash when baseUrl has a trailing slash', () => {
    expect(buildUrl('https://x.com/', '/health', {}).url).toBe('https://x.com/health')
  })

  it('collapses multiple trailing slashes on baseUrl', () => {
    expect(buildUrl('https://x.com//', '/health', {}).url).toBe('https://x.com/health')
  })

  it('inserts a slash when neither side has one', () => {
    expect(buildUrl('https://x.com', 'health', {}).url).toBe('https://x.com/health')
  })

  it('leaves a correctly formed join alone', () => {
    expect(buildUrl('https://x.com', '/health', {}).url).toBe('https://x.com/health')
  })

  it('handles an empty baseUrl for same-origin requests', () => {
    expect(buildUrl('', '/health', {}).url).toBe('/health')
  })

  it('does not corrupt the protocol slashes', () => {
    expect(buildUrl('https://x.com/api/', '/v1/health', {}).url)
      .toBe('https://x.com/api/v1/health')
  })

  it('still appends a query string after normalising', () => {
    expect(buildUrl('https://x.com/', '/items', { page: 1 }, true).url)
      .toBe('https://x.com/items?page=1')
  })
})

describe('query append when the URL already carries a query string', () => {
  it('uses & when the path template has its own query string', () => {
    // Phase 3 appended '?' unconditionally, so a path template carrying its own
    // query string produced two of them: '/search/hi?x=1?page=2'. Token
    // substitution was never the problem -- ':q' resolves correctly, and '?'
    // correctly ends the token name.
    const { url } = buildUrl('', '/search/:q?x=1', { q: 'hi', page: 2 }, true)
    expect(url).toBe('/search/hi?x=1&page=2')
  })

  it('still uses ? when there is no existing query string', () => {
    const { url } = buildUrl('', '/items', { page: 2 }, true)
    expect(url).toBe('/items?page=2')
  })

  it('appends nothing when the path consumed every param', () => {
    const { url } = buildUrl('', '/search/:q?x=1', { q: 'hi' }, true)
    expect(url).toBe('/search/hi?x=1')
  })
})

describe('a baseUrl carrying its own query string', () => {
  // Before 4.2.1 joinUrl concatenated, so the path landed inside the base's
  // query VALUE: 'https://api.test/v1?key=abc' + '/items' produced
  // '.../v1?key=abc/items', which resolves to path '/v1' — the request went to
  // a different endpoint, silently. These assert the network's view, not just
  // the string, because the old output looked plausible and resolved wrongly.
  const netView = (url: string) => {
    const u = new URL(url, 'https://fallback.test')
    return { path: u.pathname, search: u.search }
  }

  it('joins the path onto the base path, not into its query', () => {
    const { url } = buildUrl('https://api.test/v1?key=abc', '/items', {}, true)
    expect(url).toBe('https://api.test/v1/items?key=abc')
    expect(netView(url)).toEqual({ path: '/v1/items', search: '?key=abc' })
  })

  it('merges call params after the base query', () => {
    const { url } = buildUrl('https://api.test/v1?key=abc', '/items', { page: 2 }, true)
    expect(url).toBe('https://api.test/v1/items?key=abc&page=2')
    expect(netView(url)).toEqual({ path: '/v1/items', search: '?key=abc&page=2' })
  })

  it('merges a base query, a path query and call params in that order', () => {
    const { url } = buildUrl('https://api.test/v1?key=abc', '/search?x=1', { page: 2 }, true)
    expect(url).toBe('https://api.test/v1/search?key=abc&x=1&page=2')
    expect(netView(url)).toEqual({ path: '/v1/search', search: '?key=abc&x=1&page=2' })
  })

  it('keeps every param when the base carries several', () => {
    const { url } = buildUrl('https://api.test/v1?a=1&b=2', '/items', { c: 3 }, true)
    expect(url).toBe('https://api.test/v1/items?a=1&b=2&c=3')
  })

  it('leaves a base without a query exactly as it was', () => {
    // The regression guard: every shape that worked before must still work.
    expect(buildUrl('https://api.test', '/items', { page: 2 }, true).url).toBe('https://api.test/items?page=2')
    expect(buildUrl('https://api.test/', '/items', {}, true).url).toBe('https://api.test/items')
    expect(buildUrl('https://api.test', 'items', {}, true).url).toBe('https://api.test/items')
    expect(buildUrl('', '/search?x=1', { page: 2 }, true).url).toBe('/search?x=1&page=2')
  })
})

describe('a URL fragment is refused', () => {
  // A fragment is never transmitted. Before 4.2.1 a path fragment silently ate
  // the query string: '/docs#section' + { page: 2 } produced
  // '/docs#section?page=2', which the network layer reads as path '/docs' with
  // NO search at all — page=2 was dropped and nothing said so.
  it('throws for a fragment in the path', () => {
    expect(() => buildUrl('https://api.test', '/docs#section', { page: 2 }, true))
      .toThrow(/fragment/i)
  })

  it('throws for a fragment in the baseUrl', () => {
    expect(() => buildUrl('https://api.test/v1#frag', '/items', {}, true))
      .toThrow(/fragment/i)
  })

  it('names the offending value so the fix is obvious', () => {
    expect(() => buildUrl('https://api.test', '/docs#section', {}, true))
      .toThrow(/#section/)
  })
})

describe('the URL that actually reaches fetch', () => {
  // Lives here rather than in create-api.test.ts because it is the same bug as
  // the two blocks above, and the whole point is that asserting the STRING was
  // not enough: both defects produced strings that looked plausible and
  // resolved wrongly. This pins what the network layer parses out of them.
  afterEach(() => { vi.restoreAllMocks() })

  it('sends the merged query on the joined path, not a mangled string', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { seen.push(u); return new Response('{}', { status: 200 }) }))
    const api = createApi({
      baseUrl: 'https://api.test/v1?key=abc',
      requests: { search: new Request<{ q: string; page: number }, unknown>({ method: 'GET', path: '/search' }) },
    })
    await api.search({ q: 'hi', page: 2 })

    const url = new URL(seen[0])
    expect(url.pathname).toBe('/v1/search')
    expect(url.searchParams.get('key')).toBe('abc')
    expect(url.searchParams.get('q')).toBe('hi')
    expect(url.searchParams.get('page')).toBe('2')
  })

  it('reports a fragment as a Result error rather than throwing', async () => {
    // The mock returns a real Response on purpose. With a bare `vi.fn()` the
    // call resolves to undefined, the pipeline crashes reading `.ok`, and this
    // test passes even when the guard is removed — for the wrong reason.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const api = createApi({
      baseUrl: 'https://api.test',
      requests: { docs: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/docs#section' }) },
    })
    const r = await api.docs()
    expect(r.error).not.toBeNull()
    expect(r.error?.kind).toBe('network')
    expect(String(r.error?.body)).toMatch(/fragment/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
