import { describe, it, expect } from 'vitest'
import { stableKey } from '../src/utils/stable-key.js'

/** State in a private field: invisible to Object.keys, no toJSON. Spec D3 rule 18. */
class Money {
  #cents: number
  constructor(cents: number) { this.#cents = cents }
  get amount() { return this.#cents / 100 }
}
/** State in an own enumerable key, no toJSON. Rule 17: keyed like a plain object. */
class Tagged {
  constructor(public id: string) {}
}
/** toJSON decides. Rule 10. */
class Named {
  constructor(public id: string) {}
  toJSON() { return `tag:${this.id}` }
}

describe('stableKey — unchanged from stableStringify for plain data', () => {
  it('keys null as null', () => {
    expect(stableKey(null)).toBe('null')
  })

  it('keys a top-level undefined as [undefined]: a call with no params is keyable', () => {
    expect(stableKey(undefined)).toBe('[undefined]')
  })

  it('sorts object keys', () => {
    expect(stableKey({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('sorts nested object keys', () => {
    expect(stableKey({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}')
  })

  it('escapes special characters in object keys', () => {
    expect(stableKey({ 'a"b': 1 })).toBe('{"a\\"b":1}')
  })

  it('preserves array element order', () => {
    expect(stableKey([3, 1, 2])).toBe('[3,1,2]')
  })

  it('keys primitives as JSON', () => {
    expect(stableKey(42)).toBe('42')
    expect(stableKey('hello')).toBe('"hello"')
    expect(stableKey(true)).toBe('true')
    expect(stableKey(NaN)).toBe('null')
  })

  it('ignores symbol-keyed properties, as Object.keys does', () => {
    expect(stableKey({ [Symbol('s')]: 1, a: 1 })).toBe('{"a":1}')
  })

  it('keys a null-prototype object as a plain object (rule 16)', () => {
    expect(stableKey(Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }))).toBe('{"a":1}')
  })

  it('keys a class instance with own enumerable keys like a plain object (rule 17)', () => {
    expect(stableKey({ t: new Tagged('x') })).toBe('{"t":{"id":"x"}}')
  })
})

describe('stableKey — JSON.stringify semantics for omitted members (spec D3 rules 3–4, §1.10)', () => {
  it('drops an undefined member, so { a: undefined } and {} are one key', () => {
    expect(stableKey({ a: undefined })).toBe('{}')
    expect(stableKey({ a: undefined })).toBe(stableKey({}))
  })

  it('still distinguishes null from a dropped undefined', () => {
    expect(stableKey({ a: null })).toBe('{"a":null}')
    expect(stableKey({ a: null })).not.toBe(stableKey({ a: undefined }))
  })

  it('drops function and symbol members', () => {
    expect(stableKey({ a: 1, f: () => 1, s: Symbol('x') })).toBe('{"a":1}')
  })

  it('keys an undefined or function array element as null', () => {
    expect(stableKey([undefined])).toBe('[null]')
    expect(stableKey([() => 1])).toBe('[null]')
    expect(stableKey([undefined])).toBe(stableKey([null]))
  })

  it('keys a sparse array hole as null', () => {
    const sparse: number[] = []
    sparse[0] = 1
    sparse[2] = 3
    expect(stableKey(sparse)).toBe('[1,null,3]')
  })
})

describe('stableKey — toJSON decides (spec D3 rule 10)', () => {
  it('keys a Date as its ISO string', () => {
    expect(stableKey({ since: new Date('2026-01-01T00:00:00.000Z') })).toBe('{"since":"2026-01-01T00:00:00.000Z"}')
  })

  it('keys an invalid Date as null, as the wire carries it', () => {
    expect(stableKey({ d: new Date(NaN) })).toBe('{"d":null}')
  })

  it('keys an object by what its toJSON returns, not its own keys', () => {
    expect(stableKey({ t: new Named('x') })).toBe('{"t":"tag:x"}')
  })

  it('passes the property key to toJSON, as JSON.stringify does', () => {
    expect(stableKey({ a: { toJSON: (k: string) => k } })).toBe('{"a":"a"}')
    expect(stableKey({ toJSON: (k: string) => `top:${k}` })).toBe('"top:"')
  })

  it('declines when toJSON throws', () => {
    expect(stableKey({ t: { toJSON: () => { throw new Error('boom') } } })).toBeNull()
  })
})

describe('stableKey — tagged collections and views (spec D3 rules 12–14)', () => {
  it('keys a Map by sorted entries with a tag', () => {
    expect(stableKey(new Map([['b', 2], ['a', 1]]))).toBe('Map{"a":1,"b":2}')
  })

  it('keys a Set by elements in insertion order with a tag', () => {
    expect(stableKey(new Set([2, 1]))).toBe('Set[2,1]')
  })

  it('keys a typed array by constructor name and elements', () => {
    expect(stableKey(new Uint8Array([1, 2]))).toBe('Uint8Array[1,2]')
    expect(stableKey(new Float64Array([1.5]))).toBe('Float64Array[1.5]')
    expect(stableKey(new BigInt64Array([1n]))).toBe('BigInt64Array[1]')
  })

  it('keys a DataView by its bytes', () => {
    expect(stableKey(new DataView(new Uint8Array([7, 8]).buffer))).toBe('DataView[7,8]')
  })

  it('never equates a Map with a plain object, or a Set with an array, or two views with the same bytes', () => {
    expect(stableKey(new Map([['a', 1]]))).not.toBe(stableKey({ a: 1 }))
    expect(stableKey(new Set([1, 2]))).not.toBe(stableKey([1, 2]))
    expect(stableKey(new Uint16Array([1]))).not.toBe(stableKey(new Uint8Array([1, 0])))
  })

  it('sorts Map entries by their keyed key, so insertion order does not matter', () => {
    const a = new Map<unknown, number>([[{ x: 1 }, 1], [{ y: 2 }, 2]])
    const b = new Map<unknown, number>([[{ y: 2 }, 2], [{ x: 1 }, 1]])
    expect(stableKey(a)).toBe(stableKey(b))
  })

  it('keys an undefined Map key or Set element as null', () => {
    expect(stableKey(new Set([undefined]))).toBe('Set[null]')
    expect(stableKey(new Map([[undefined, 1]]))).toBe('Map{null:1}')
  })
})

describe('stableKey — declines (spec D3 rules 5, 6, 8, 9, 11, 18)', () => {
  it.each<[string, unknown]>([
    ['a BigInt member', { id: 10n }],
    ['a top-level BigInt', 10n],
    ['a BigInt inside an array', [10n]],
    ['a BigInt as a Map value', new Map([['id', 10n]])],
    ['a BigInt as a Set element', new Set([10n])],
    ['a nested ArrayBuffer', { buf: new ArrayBuffer(1) }],
    ['a nested Blob', { b: new Blob(['x']) }],
    ['a nested FormData', { f: new FormData() }],
    ['a nested URLSearchParams', { q: new URLSearchParams('a=1') }],
    ['a class instance with only private state', { price: new Money(100) }],
    ['an Error', { e: new Error('x') }],
    ['a boxed Number', new Number(1)],
    ['a nested boxed String', { s: new String('ab') }],
    ['a top-level function', () => 1],
    ['a top-level symbol', Symbol('x')],
  ])('declines %s', (_label, value) => {
    expect(stableKey(value)).toBeNull()
  })

  it('declines a circular structure, and does so on every call', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    expect(stableKey(o)).toBeNull()
    expect(stableKey(o)).toBeNull()
  })

  it('does not decline the same object referenced twice as siblings', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(stableKey({ a: d, b: d })).toBe('{"a":"2026-01-01T00:00:00.000Z","b":"2026-01-01T00:00:00.000Z"}')
  })

  it('declines when a getter throws, rather than throwing', () => {
    const params = { get a(): number { throw new Error('boom') } }
    expect(() => stableKey(params)).not.toThrow()
    expect(stableKey(params)).toBeNull()
  })
})

describe('stableKey — the collisions the audit found are gone (spec "The problem")', () => {
  it.each<[string, unknown, unknown]>([
    ['nested Date', { since: new Date('2026-01-01') }, { since: new Date('2026-02-01') }],
    ['nested Map', { f: new Map([['a', 1]]) }, { f: new Map([['b', 2]]) }],
    ['nested Set', { ids: new Set([1]) }, { ids: new Set([2]) }],
    ['nested typed array', { bytes: new Uint8Array([1, 2]) }, { bytes: new Uint8Array([3, 4]) }],
    ['class instance with an own key', { t: new Tagged('x') }, { t: new Tagged('y') }],
    ['class instance with toJSON', { t: new Named('x') }, { t: new Named('y') }],
  ])('%s: two values, two keys', (_label, a, b) => {
    const ka = stableKey(a)
    const kb = stableKey(b)
    expect(ka).not.toBeNull()
    expect(kb).not.toBeNull()
    expect(ka).not.toBe(kb)
  })
})
