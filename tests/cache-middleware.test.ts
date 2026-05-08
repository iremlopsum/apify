import { describe, it, expect, vi, afterEach } from 'vitest'
import { CacheStore, stableStringify } from '../src/utils/cache.js'

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe('stableStringify', () => {
  it('returns null for null', () => {
    expect(stableStringify(null)).toBe('null')
  })

  it('returns [undefined] for undefined', () => {
    expect(stableStringify(undefined)).toBe('[undefined]')
  })

  it('distinguishes null and undefined in objects', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({ a: undefined }))
  })

  it('sorts object keys alphabetically', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('sorts nested object keys', () => {
    expect(stableStringify({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}')
  })

  it('escapes special characters in object keys', () => {
    expect(stableStringify({ 'a"b': 1 })).toBe('{"a\\"b":1}')
  })

  it('preserves array element order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles number primitives', () => {
    expect(stableStringify(42)).toBe('42')
  })

  it('handles string primitives with quoting', () => {
    expect(stableStringify('hello')).toBe('"hello"')
  })

  it('handles boolean primitives', () => {
    expect(stableStringify(true)).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

describe('CacheStore', () => {
  it('returns null for an unknown key', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    expect(store.get('missing')).toBeNull()
  })

  it('returns a stored value within TTL', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('key', { name: 'Alice' })
    expect(store.get('key')).toEqual({ name: 'Alice' })
  })

  it('returns null after TTL expires and deletes the entry', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 1000, maxSize: 10 })
    store.set('key', 'value')
    dateSpy.mockReturnValue(1001) // past TTL
    expect(store.get('key')).toBeNull()
    // confirm the entry was removed (not merely skipped)
    dateSpy.mockReturnValue(500) // back inside what would have been TTL
    expect(store.get('key')).toBeNull()
  })

  it('returns null exactly at TTL boundary', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 1000, maxSize: 10 })
    store.set('key', 'value')
    dateSpy.mockReturnValue(1000) // exactly at TTL
    expect(store.get('key')).toBeNull()
  })

  it('clears all entries', () => {
    const store = new CacheStore({ ttl: 60_000, maxSize: 10 })
    store.set('a', 1)
    store.set('b', 2)
    store.clear()
    expect(store.get('a')).toBeNull()
    expect(store.get('b')).toBeNull()
  })

  it('evicts the oldest entry when maxSize is reached', () => {
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(0)
    const store = new CacheStore({ ttl: 60_000, maxSize: 2 })
    store.set('a', 'first')   // timestamp 0 — oldest
    dateSpy.mockReturnValue(1)
    store.set('b', 'second')  // timestamp 1
    dateSpy.mockReturnValue(2)
    store.set('c', 'third')   // triggers eviction of 'a'
    expect(store.get('a')).toBeNull()    // evicted
    expect(store.get('b')).toBe('second')
    expect(store.get('c')).toBe('third')
  })
})
