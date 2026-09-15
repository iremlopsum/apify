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
 * A heuristic for whether `reason` — something a middleware threw — is
 * *probably* a propagation of `signalReason`, the reason our own signal
 * aborted with. It is not proof: `throw new Error('cache write failed while
 * unwinding', { cause: ctx.request.signal.reason })` is the idiomatic way to
 * explain *why* a middleware is failing, not a claim to *be* that failure,
 * and this heuristic still classifies it `'abort'` — a known false positive,
 * accepted because the alternative (identity-only, no `.cause` match at all)
 * is measurably worse: it misses `node:timers/promises`' `setTimeout(ms,
 * undefined, { signal })`, which rejects with a *fresh* `AbortError` whose
 * `.cause` is the signal's reason rather than the reason itself — a shape
 * that also turns up in queueing libraries and IndexedDB wrappers built on
 * `AbortSignal`. One level of `.cause` unwrapping catches that real case,
 * without going further: an error that merely *chains* to something
 * unrelated (an `AbortError` a middleware manufactured on its own, whose
 * `.cause` is not our reason) must still fail this check and classify as
 * `'middleware'` — see the IndexedDB scenario in `syntheticResult`'s doc,
 * which this must not reopen.
 *
 * `reason` is an arbitrary value a middleware threw, so reading `.cause`
 * off it is not safe to do unguarded — an accessor property, a `Proxy`, or a
 * cross-realm wrapper can throw on property access. This runs inside the
 * last-resort `.catch` that converts a rejection into a `Result`; a throw
 * here would escape with nothing downstream able to catch it, exactly the
 * "never throws" contract this whole classification exists in service of.
 * Treat a throwing `.cause` getter as "does not match" rather than letting
 * it propagate.
 */
export function propagatesReason(reason: unknown, signalReason: unknown): boolean {
  if (reason === signalReason) return true
  if (typeof reason !== 'object' || reason === null) return false
  try {
    return (reason as { cause?: unknown }).cause === signalReason
  } catch {
    return false
  }
}
