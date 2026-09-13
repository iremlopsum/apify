/**
 * Composes several abort signals into one that aborts when the first of them
 * aborts, carrying that signal's `reason` through.
 *
 * Deliberately not `AbortSignal.any`, which requires Node 20.3+ (this package
 * declares `node >= 20`) and Chrome 116 / Safari 17.4 / Firefox 124. This
 * library targets any runtime with `fetch`, so a platform API with a floor
 * that high is not usable here.
 *
 * Preserving `reason` is load-bearing: it is what keeps a `TimeoutError`
 * distinguishable from a plain `AbortError` after merging, which the error
 * model depends on to tell a timeout from a cancellation.
 *
 * @param signals - Signals to merge; `undefined` entries are ignored.
 * @returns `undefined` if no signal was given, the sole signal if exactly one
 *   was (no controller allocated), otherwise a merged signal.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined)

  // Fast paths: allocate nothing for the common cases.
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]

  const controller = new AbortController()

  const abortWith = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  for (const signal of defined) {
    if (signal.aborted) {
      abortWith(signal.reason)
      break
    }
    signal.addEventListener('abort', () => abortWith(signal.reason), { once: true })
  }

  return controller.signal
}
