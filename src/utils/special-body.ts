/**
 * True when `value` is a body type that cannot be decomposed into key-value
 * pairs — `FormData`, `Blob`, `ArrayBuffer`, `URLSearchParams`, or a raw
 * string.
 *
 * Used by `create-api.ts`'s URL-building step, which skips path/query
 * decomposition for these entirely and hands them straight to
 * `serializeBody`. A raw string belongs here: it is a body-serialisation
 * concern, and a string can't be decomposed into path/query params either.
 *
 * Do not use this to decide whether params can be *keyed* (cache/share) —
 * that is a different question, answered by {@link isOpaqueParams} below.
 * `cacheMiddleware` and `share`'s `canShare` gate used to share this
 * predicate, but excluding `string` disabled caching and coalescing for
 * every string-param endpoint, even though `stableStringify` keys a string
 * soundly. Fixed in 2.2.1 by giving the keying question its own predicate.
 */
export function isSpecialBody(value: unknown): boolean {
  return (
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams ||
    typeof value === 'string'
  )
}

/**
 * True when `value`'s own enumerable keys don't distinguish it from any
 * other value of the same type — so it cannot be soundly used to build a
 * cache/share key. `stableStringify` (`./cache.js`) keys most values by
 * their content, but for a plain `object` it falls through to
 * `Object.keys(obj).sort()`, and several built-ins store their real content
 * *outside* their own enumerable own-properties, so `Object.keys()` returns
 * `[]` for every instance regardless of what it actually holds — collapsing
 * every one of them to the identical literal `"{}"`.
 *
 * `FormData`, `Blob`, `ArrayBuffer` and `URLSearchParams` are the four
 * originally identified (their content is genuinely opaque to any
 * synchronous, ownProperty-based key builder). `Date`, `Map` and `Set` have
 * the identical shape — a `Date`'s time value, and a `Map`/`Set`'s entries,
 * are internal slots, not own-enumerable properties — so they collapse the
 * same way and were added in 2.2.1 once the pattern was recognised as a
 * class, not a fixed list of four. This list is not a closed set: any value
 * with the same property — its distinguishing content lives outside
 * `Object.keys()` — belongs here too.
 *
 * Deliberately narrower than {@link isSpecialBody}: a raw `string` is left
 * out on purpose. `stableStringify` keys a string correctly, via
 * `JSON.stringify` — two different strings produce two different keys, so
 * excluding it here would be over-broad, not safe.
 *
 * Used by `cacheMiddleware` and `share`'s `canShare` gate to decide whether
 * params can be keyed at all — a question `isSpecialBody` also used to
 * answer for both, but too broadly: excluding `string` there disabled
 * caching and coalescing for any string-param endpoint, even though such an
 * endpoint is soundly keyable. `isSpecialBody` itself must not change — it
 * answers a different question (whether params can be decomposed into
 * path/query pairs, where a raw string legitimately needs the same
 * pass-through treatment as these seven) — and its one call site
 * (`create-api.ts`'s URL-building bypass) must keep using it, not this.
 * `serializeBody` (`./serialize.js`) is a separate concern entirely: it has
 * its own inline type checks and never imports `isSpecialBody`.
 */
export function isOpaqueParams(value: unknown): boolean {
  return (
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set
  )
}
