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

import { describe, it, expect } from 'vitest'
import { buildUrl } from '../src/utils/path-params.js'

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
})
