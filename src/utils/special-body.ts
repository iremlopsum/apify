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
 * True when `value` is one of four object body types whose key-value shape
 * cannot be recovered for keying purposes — `FormData`, `Blob`,
 * `ArrayBuffer`, or `URLSearchParams`.
 *
 * Deliberately narrower than {@link isSpecialBody}: a raw `string` is left
 * out on purpose. `stableStringify` (`./cache.js`) keys a string correctly —
 * via `JSON.stringify`, so two different strings produce two different keys
 * — it is only these four object types that all collapse to the identical
 * literal `"{}"`, because `stableStringify` falls through to `Object.keys()`
 * for any `object`, and `Object.keys()` returns `[]` for every one of them
 * regardless of their actual content.
 *
 * Used by `cacheMiddleware` and `share`'s `canShare` gate to decide whether
 * params can be keyed at all — a question `isSpecialBody` also used to
 * answer for both, but too broadly: excluding `string` there disabled
 * caching and coalescing for any string-param endpoint, even though such an
 * endpoint is soundly keyable. `isSpecialBody` itself must not change — it
 * answers a different question (how to serialise a request body, where a
 * raw string legitimately needs the same pass-through treatment as these
 * four) — and its call sites (body serialisation, URL building) must keep
 * using it, not this.
 */
export function isOpaqueParams(value: unknown): boolean {
  return (
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams
  )
}
