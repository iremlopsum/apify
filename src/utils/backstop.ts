// =============================================================================
// backstop.ts — settles a call whose middleware ignores the operation's signal
// =============================================================================
//
// The deadline (`timeout`) and the caller's `signal` reach middleware as
// `ctx.request.signal` and reach `fetch` from there. That bounds everything
// the signal governs, and nothing else: a middleware awaiting work of its own
// that never settles — a stalled auth-token refresh is the realistic case —
// used to leave the call pending forever, with no Result and no onError, even
// though `timeout` is documented as covering the whole middleware chain.
//
// A promise cannot be cancelled, so the stalled middleware keeps running. What
// the library can do is stop waiting for it: once the operation's own signal
// aborts, the call settles with the same abort Result `fetch` would have
// produced, and anything the chain does afterwards is discarded.
//
// Both clients use this. They are parallel pipelines (see architecture.md),
// but this piece has no client-specific behaviour, so it is shared rather
// than duplicated.
// =============================================================================

/**
 * One call's backstop. Create one per `execute()`, `watch` the operation's
 * signals, wrap `core` with `guard`, and hand the chain's promise to `follow`.
 */
export interface Backstop<T> {
  /**
   * Observe a signal that governs this operation. Once it aborts, the chain
   * gets one macrotask to settle on its own; if it has not, the call settles
   * with `abortResult(signal)`. A signal that is already aborted starts that
   * grace period immediately.
   *
   * Only the operation's *own* signals belong here — the deadline, the
   * caller's signal, a share refcount, a dedupe supersede. A signal some
   * middleware installed is that middleware's business.
   */
  watch(signal: AbortSignal | undefined): void

  /**
   * Wraps the innermost layer. After the backstop has settled the call, a
   * late `next()` from a resumed middleware returns the Result the caller
   * already has, without running `core` — so no request goes out and no
   * dedupe registration happens for a call nobody is waiting on.
   */
  guard<C>(core: (ctx: C) => Promise<T>): (ctx: C) => Promise<T>

  /**
   * Settles with the chain's own result unless the backstop already has.
   * The returned promise settles exactly once. Callers convert the chain's
   * rejections into Results before following it; should one slip through
   * anyway it is passed on rather than swallowed, so the callers' own
   * defence-in-depth still sees it instead of a promise that never settles.
   */
  follow(chain: Promise<T>): Promise<T>
}

/**
 * @param abortResult - Builds the Result for a call whose signal aborted and
 *   whose chain did not answer. Called at most once, and only after the
 *   grace period, so it may read state set up after `createBackstop` returns.
 */
export function createBackstop<T>(abortResult: (signal: AbortSignal) => T): Backstop<T> {
  let settled = false
  let outcome: T
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })

  let timer: ReturnType<typeof setTimeout> | undefined
  const watched: Array<{ signal: AbortSignal; listener: () => void }> = []

  const finish = (): boolean => {
    if (settled) return false
    settled = true
    // Nothing may outlive the call: a caller's signal is often long-lived (a
    // component-scoped controller reused across many calls), so a listener
    // left on it would accumulate one per call — see any-signal.ts.
    for (const { signal, listener } of watched) signal.removeEventListener('abort', listener)
    watched.length = 0
    if (timer !== undefined) clearTimeout(timer)
    return true
  }

  const settle = (value: T): void => {
    if (!finish()) return
    outcome = value
    resolve(value)
  }

  // Why a grace period instead of settling on the abort itself: a chain that
  // *responds* to the abort must keep its own answer. `fetch` rejects on
  // abort within microtasks, a middleware rethrowing the reason is classified
  // by provenance, and a fallback middleware may turn a timeout into a
  // cached success — all of which already settle promptly and would be
  // preempted by an immediate race, changing Results that are correct today.
  // One macrotask is enough for every one of those; a chain still pending
  // after it is waiting on something the signal does not reach.
  const arm = (signal: AbortSignal): void => {
    if (settled || timer !== undefined) return
    timer = setTimeout(() => {
      // A throw inside a timer callback is an uncaught exception, not a
      // rejection anyone can handle, so it is routed onto the promise.
      let value: T
      try { value = abortResult(signal) } catch (err) { if (finish()) reject(err); return }
      settle(value)
    }, 0)
  }

  return {
    watch(signal) {
      // Duck-typed, not `instanceof`: `result.retry` is handed to consumers
      // as a bare function, so `[r].map(r.retry)` or `retry({}, 0)` delivers
      // arbitrary values into execute()'s internal signal parameter. Anything
      // that cannot be listened to is not a signal this call can be governed
      // by, and must not throw here — see tests/cancellation.test.ts.
      if (settled || typeof signal?.addEventListener !== 'function') return
      if (signal.aborted) { arm(signal); return }
      const listener = (): void => arm(signal)
      watched.push({ signal, listener })
      signal.addEventListener('abort', listener, { once: true })
    },

    guard(core) {
      // `settled` is only ever true here via `settle` (a rejection passed on
      // by `follow` has no chain left to call next()), so `outcome` is set.
      return ctx => (settled ? Promise.resolve(outcome) : core(ctx))
    },

    follow(chain) {
      chain.then(settle, (err: unknown) => { if (finish()) reject(err) })
      return promise
    },
  }
}
