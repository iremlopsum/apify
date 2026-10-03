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
 * that is a different question, answered by `stableKey` in `./stable-key.js`,
 * which keys by content at every depth and returns `null` for what it cannot
 * key. `cacheMiddleware` and `share`'s gate used to share this predicate, but
 * excluding `string` disabled caching and coalescing for every string-param
 * endpoint even though a string keys soundly (fixed in 2.2.1).
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
