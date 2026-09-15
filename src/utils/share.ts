import type { Result } from '../types.js'

interface Entry {
  promise: Promise<Result<unknown>>
  controller: AbortController
  refs: number
}

/**
 * The reason a shared request is aborted when its last caller releases.
 *
 * This is not a failure. Every caller has already received its own Result and
 * reported it; the underlying request is simply no longer wanted. Reporting it
 * again as an operation failure is what made a single shared timeout produce
 * two `onError` calls before 2.2.1.
 */
export const ABANDONED: unique symbol = Symbol('apify.abandoned')

/** Whether an abort reason is the tracker's own abandonment sentinel. */
export function isAbandoned(reason: unknown): boolean {
  return reason === ABANDONED
}

/**
 * Joins identical concurrent requests onto one in-flight call.
 *
 * Sibling of `DedupeTracker`, with the opposite intent: dedupe cancels the
 * older request, share joins the existing one.
 *
 * Each caller holds a reference. A caller that gives up releases its
 * reference and the shared request continues for everyone else; only when the
 * last reference is released is the underlying request aborted. One component
 * unmounting must never cancel a request nine others are waiting on.
 */
export class ShareTracker {
  private inflight = new Map<string, Entry>()

  /**
   * Join the in-flight request for `key`, or start one with `exec`.
   *
   * @param key - Identity of the call; identical keys share.
   * @param exec - Starts the real request. Called only for the first caller,
   *   and given the shared signal to pass to `fetch`.
   * @returns The shared promise and a `release` this caller must call if it
   *   gives up waiting.
   */
  acquire(
    key: string,
    exec: (signal: AbortSignal) => Promise<Result<unknown>>
  ): { promise: Promise<Result<unknown>>; release: (reason?: unknown) => boolean } {
    let entry = this.inflight.get(key)

    // A dying entry: every sharer has already released (refs <= 0) or its
    // controller has already been aborted, but the `.finally()` cleanup
    // below has not run yet — that only happens once the real request's
    // promise actually settles, at least one microtask after a synchronous
    // `controller.abort()`. Joining it here would hand this caller a
    // synthetic abort result instead of a real request, e.g.:
    //
    //   controller.abort()      // last sharer releases; refs -> 0, aborts
    //   api.get(params)         // no await in between — must NOT join this
    //
    // No third, synchronous flag is needed to close that window: `release`
    // decrements `refs` unconditionally, before it ever calls `abort()`, so
    // `refs <= 0` is already true for any caller arriving synchronously
    // during (or after) that abort call — including one arriving from
    // *inside* an `abort` event listener the call triggers, since
    // `AbortController.abort()` sets `signal.aborted` before it fires any
    // listeners. Both were verified empirically: forcing a would-be "dead"
    // marker to be set after `abort()` instead of before never changed a
    // single test's outcome, in this guard or in a listener-nested re-entry.
    //
    // Treat it as if no entry exists so a fresh one is started instead.
    if (entry && (entry.refs <= 0 || entry.controller.signal.aborted)) {
      entry = undefined
    }

    if (!entry) {
      const controller = new AbortController()
      const created: Entry = { controller, refs: 0, promise: undefined as unknown as Promise<Result<unknown>> }
      created.promise = exec(controller.signal).finally(() => {
        // Identity check: only clear the entry if it is still ours. An entry
        // replaced while this one was settling belongs to a newer call, and
        // deleting it would silently disable sharing for that key — the same
        // class of bug fixed in DedupeTracker.clear() in 2.1.0.
        if (this.inflight.get(key) === created) this.inflight.delete(key)
      })
      this.inflight.set(key, created)
      entry = created
    }

    entry.refs++
    const held = entry
    let released = false

    return {
      promise: held.promise,
      // Returns whether THIS call was the one that dropped refs to zero and
      // aborted the shared controller — the caller (create-api.ts) uses this
      // to decide whether it must report the failure itself. A non-last
      // release leaves the shared request running: it will never see this
      // caller's give-up, so nothing else would ever report it, and the
      // caller must. A last release aborts the shared request, whose own
      // execute() will observe that abort and report it through the normal
      // post-execution hook — reporting it again here would double it.
      release: (reason?: unknown): boolean => {
        if (released) return false
        released = true
        held.refs--
        if (held.refs <= 0 && !held.controller.signal.aborted) {
          // A caller that already has its own abort/timeout reason keeps it
          // (create-api.ts still relies on that reason to classify its own
          // Result — that's Task 7's territory, not this one's). Only a
          // reason-less release, as from a bare `release()`, gets tagged
          // ABANDONED, so this method's contract (distinguishable reason
          // when nobody supplied one) holds without changing what today's
          // callers observe.
          held.controller.abort(reason ?? ABANDONED)
          return true
        }
        return false
      },
    }
  }
}
