// =============================================================================
// stable-key.ts — the identity of a request's params, for share and cacheMiddleware
// =============================================================================

/**
 * Builds the string that decides whether two calls are "the same request".
 * `share` hands one in-flight response to every caller with the same key;
 * `cacheMiddleware` serves a stored response for it. Equal keys must therefore
 * mean "the same request", and `null` means "cannot say" — the caller must
 * neither share nor cache. Declining is always safe; handing one caller the
 * response meant for another never is.
 *
 * The rule: the key never merges two values that any transport keeps apart —
 * a JSON body or a query string, where `buildUrl` writes array items with
 * `String()`. Over-separating only costs a share or cache hit; merging hands
 * one request's response to another.
 *
 * Keys are built by content, in the order the rules are checked:
 *
 * - `undefined` at the top level → `[undefined]` (a call with no params is
 *   keyable). An `undefined` *object member* is dropped, since both transports
 *   omit it, so `{ a: undefined }` and `{}` key the same. As an array element,
 *   Map key/value or Set element it keys as the unquoted token `undefined`
 *   (a query string sends `ids=undefined`, not `ids=null`), and so does a
 *   sparse array hole.
 * - string, finite number, boolean → `JSON.stringify`. `NaN`, `Infinity` and
 *   `-Infinity` key as those unquoted tokens, never as `null`: a query string
 *   sends them as written.
 * - anything with a `toJSON` function → `toJSON(<key of what it returns>)`,
 *   called with the property name as `JSON.stringify` does. A `Date` keys as
 *   `toJSON("2026-01-01T00:00:00.000Z")`, an invalid one as `toJSON(null)`.
 *   The tag is there because a query string sends `String(date)` — local
 *   time, or `Invalid Date` — not the ISO string or `null`. If `toJSON`
 *   returns `undefined` the member is dropped, as JSON does.
 * - `Map` → `Map{k:v,...}` with entries sorted by key; `Set` → `Set[...]` in
 *   insertion order; typed arrays and `DataView` → `Uint8Array[1,2]` etc. The
 *   tag matters: a Map with entry `a: 1` does not send the same bytes as
 *   `{ a: 1 }`, so it must not share its key.
 * - arrays → `[...]`; plain objects → sorted, JSON-quoted keys. Any other
 *   object with own enumerable keys is keyed the same way, since that is what
 *   `JSON.stringify` sends for it.
 *
 * None of the tags can collide with a string, which is always JSON-quoted.
 *
 * Declined (`null`), at any depth: a BigInt (`JSON.stringify` throws on it);
 * a function or symbol, wherever it appears (a query string would send its
 * source text or description); `ArrayBuffer`, `Blob`, `FormData`,
 * `URLSearchParams` (content not readable synchronously, or not
 * representable); a boxed primitive; a circular structure; and any other
 * object with no own enumerable key, whose state is invisible — a class
 * holding its state in private fields, an `Error`, a `Promise`. Before 4.4.3
 * every one of these keyed as `{}` below the top level, so two different
 * requests shared one response. `isSpecialBody` (`./special-body.js`) answers
 * a different question — whether params can be split into path and query
 * pairs — and is not a keying check.
 *
 * Never throws: a throwing getter or `toJSON` becomes `null`.
 */
export function stableKey(value: unknown): string | null {
  if (value === undefined) return '[undefined]'
  try {
    const out = visit(value, '', new Set())
    return out === undefined ? null : out
  } catch {
    return null
  }
}

/**
 * `string` is a key, `null` is decline, `undefined` is "omit this member"
 * (an `undefined` value, or a `toJSON` that returns one).
 */
type Visit = string | null | undefined

function visit(value: unknown, key: string, seen: Set<object>): Visit {
  switch (typeof value) {
    case 'undefined':
      return undefined
    case 'function':
    case 'symbol':
    case 'bigint':
      return null
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : String(value)
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'object':
      break
    default:
      return null
  }
  if (value === null) return 'null'
  const obj = value as object
  if (obj instanceof Number || obj instanceof String || obj instanceof Boolean) return null
  if (seen.has(obj)) return null // an ancestor on the current path: circular
  seen.add(obj)
  try {
    const toJSON = (obj as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
      const inner = visit(toJSON.call(obj, key), key, seen)
      return typeof inner === 'string' ? `toJSON(${inner})` : inner
    }
    if (obj instanceof ArrayBuffer || obj instanceof Blob || obj instanceof FormData || obj instanceof URLSearchParams) {
      return null
    }
    if (ArrayBuffer.isView(obj)) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'ArrayBufferView'
      const elements =
        obj instanceof DataView
          ? Array.from(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength))
          : Array.from(obj as unknown as ArrayLike<unknown>)
      return `${name}[${elements.map(String).join(',')}]`
    }
    if (obj instanceof Map) {
      const entries: string[] = []
      for (const [k, v] of obj) {
        const ks = element(k, '', seen)
        if (ks === null) return null
        const vs = element(v, '', seen)
        if (vs === null) return null
        entries.push(`${ks}:${vs}`)
      }
      entries.sort()
      return `Map{${entries.join(',')}}`
    }
    if (obj instanceof Set) {
      const elements: string[] = []
      for (const v of obj) {
        const s = element(v, '', seen)
        if (s === null) return null
        elements.push(s)
      }
      return `Set[${elements.join(',')}]`
    }
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i++) {
        const s = element(obj[i], String(i), seen)
        if (s === null) return null
        parts.push(s)
      }
      return `[${parts.join(',')}]`
    }
    const keys = Object.keys(obj)
    const proto = Object.getPrototypeOf(obj) as unknown
    const plain = proto === Object.prototype || proto === null
    if (!plain && keys.length === 0) return null // state the key cannot see
    const pairs: string[] = []
    for (const k of keys.sort()) {
      const s = visit((obj as Record<string, unknown>)[k], k, seen)
      if (s === null) return null
      if (s === undefined) continue
      pairs.push(`${JSON.stringify(k)}:${s}`)
    }
    return `{${pairs.join(',')}}`
  } finally {
    seen.delete(obj)
  }
}

/**
 * An array element, Map key or value, or Set element: an omitted value keys as
 * the token `undefined`, never `null` — a query string sends `ids=undefined`
 * for it, so it must not share a key with `[null]`.
 */
function element(value: unknown, key: string, seen: Set<object>): string | null {
  const s = visit(value, key, seen)
  return s === undefined ? 'undefined' : s
}
