/**
 * Classifies a thrown value as a cancellation, a timeout, or neither.
 *
 * Both surface from `fetch` as a rejection with no HTTP response, so without
 * this check they are indistinguishable from each other and from a genuine
 * network failure.
 *
 * Matches on `.name` rather than `instanceof DOMException` because runtimes
 * disagree on the class: browsers and Node throw a `DOMException`,
 * `AbortSignal.timeout()` throws one named `TimeoutError`, and some edge
 * runtimes throw a plain `Error` carrying the same name.
 *
 * @returns `'timeout'`, `'abort'`, or `null` when it is neither.
 */
export function abortKind(err: unknown): 'abort' | 'timeout' | null {
  if (typeof err !== 'object' || err === null) return null
  const name = (err as { name?: unknown }).name
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'abort'
  return null
}
