/**
 * True when `value` is a body type that cannot be decomposed into key-value
 * pairs — `FormData`, `Blob`, `ArrayBuffer`, `URLSearchParams`, or a raw
 * string.
 *
 * Shared by two call sites that both need to treat these types specially,
 * for different reasons:
 *
 * - `create-api.ts`'s URL-building step skips path/query decomposition for
 *   them entirely and hands them straight to `serializeBody`.
 * - The `share: true` gate excludes them from coalescing: `stableStringify`
 *   (`./cache.js`) falls through to `Object.keys()` for any `object`, and
 *   `Object.keys()` returns `[]` for all four of these types regardless of
 *   their actual content — so two calls with *different* FormData/Blob/
 *   ArrayBuffer/URLSearchParams payloads would otherwise collapse onto the
 *   same share key, coalesce into one request, and hand every caller the
 *   response to whichever payload happened to be sent. Declining to share is
 *   always safe; corrupting a response never is.
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
