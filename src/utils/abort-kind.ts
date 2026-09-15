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

/**
 * Whether `reason` — something a middleware threw — is provably a
 * propagation of `signalReason`, the reason our own signal aborted with.
 *
 * Exact identity (`reason === signalReason`) is the direct case: a
 * middleware that reads `ctx.request.signal.reason` and rethrows it
 * verbatim. But a middleware awaiting an abortable helper often doesn't get
 * handed the reason itself back — `node:timers/promises`' `setTimeout(ms,
 * undefined, { signal })` rejects with a *fresh* `AbortError` whose `.cause`
 * is the signal's reason, not the reason itself, and the same pattern shows
 * up in queueing libraries and IndexedDB wrappers built on `AbortSignal`.
 * One level of `.cause` unwrapping catches that case too, without going
 * further: an error that merely *chains* to something unrelated (an
 * `AbortError` a middleware manufactured on its own, whose `.cause` is not
 * our reason) must still fail this check and classify as `'middleware'` —
 * see the IndexedDB scenario in `syntheticResult`'s doc, which this must not
 * reopen.
 */
export function propagatesReason(reason: unknown, signalReason: unknown): boolean {
  if (reason === signalReason) return true
  if (typeof reason !== 'object' || reason === null) return false
  return (reason as { cause?: unknown }).cause === signalReason
}
