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
  const registered: Array<{ signal: AbortSignal; listener: () => void }> = []

  // Once the race is decided the remaining listeners are dead weight, and each
  // one keeps this controller reachable for as long as its input signal lives.
  // A caller's signal often outlives the request by a lot — a component-scoped
  // controller reused across many calls — so dropping them promptly is what
  // stops one dead listener accumulating per request.
  const cleanup = (): void => {
    for (const entry of registered) entry.signal.removeEventListener('abort', entry.listener)
    registered.length = 0
  }

  const abortWith = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
    cleanup()
  }

  for (const signal of defined) {
    if (signal.aborted) {
      abortWith(signal.reason)
      break
    }
    const listener = (): void => abortWith(signal.reason)
    registered.push({ signal, listener })
    signal.addEventListener('abort', listener, { once: true })
  }

  return controller.signal
}
