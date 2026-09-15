import type { Result } from '../types.js'

interface Entry {
  promise: Promise<Result<unknown>>
  controller: AbortController
  refs: number
  /**
   * Whether the operation has produced a `Result` yet.
   *
   * Set by the operation itself, synchronously, before it reports anything —
   * which is the only moment at which this is knowable. Every hop downstream
   * of that (this class's own `.finally`, a sharer's `.then`) runs strictly
   * later, so a flag set there is always still false during the window that
   * matters. See `hasSettled`.
   */
  settled: boolean
}

/**
 * The reason a shared request is aborted when its last caller releases.
 *
 * This is not a failure — the underlying request is simply no longer wanted,
 * not the operation ended in error. Reporting it again as an operation
 * failure is what made a single shared timeout produce two `onError` calls
 * before 2.2.1. (It is not true that every caller has already *reported* its
 * own give-up, only that it has already *received* its own Result: since
 * Task 10, `onError` never fires for `error.kind === 'abort'` at all, so a
 * plain abort-flavoured give-up reports zero times, not one. What matters
 * here is narrower — this sentinel is what lets create-api.ts's own
 * post-execution hook recognise "nobody is waiting" and not report the
 * operation's own outcome as a second, misleading failure.)
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
   *   and given the shared signal to pass to `fetch`, plus a `markSettled`
   *   callback it must invoke the moment it has a `Result` — before it reports
   *   that Result anywhere.
   * @returns The shared promise, a `release` this caller must call if it gives
   *   up waiting, and `hasSettled` — a synchronous reader every sharer of this
   *   operation shares, not a per-caller closure.
   */
  acquire(
    key: string,
    exec: (signal: AbortSignal, markSettled: () => void) => Promise<Result<unknown>>
  ): { promise: Promise<Result<unknown>>; release: () => boolean; hasSettled: () => boolean } {
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
      const created: Entry = {
        controller,
        refs: 0,
        settled: false,
        promise: undefined as unknown as Promise<Result<unknown>>,
      }
      created.promise = exec(controller.signal, () => { created.settled = true }).finally(() => {
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
      // Per-operation, so a joiner sees it too — the give-up this guards
      // against can arrive on any sharer's signal, not just the first one's.
      hasSettled: (): boolean => held.settled,
      // Returns whether THIS call was the one that dropped refs to zero and
      // aborted the shared controller. It is part of the tracker's own
      // contract (tests/share-tracker.test.ts asserts it), not a signal for
      // the caller to decide reporting by: create-api.ts's call site is
      // `if (!hasSettled()) fireOnError(...)`, not unconditional, and
      // `fireOnError` itself drops anything with `error.kind === 'abort'`
      // regardless. The ABANDONED reason below serves a narrower purpose —
      // it is what keeps the shared request's OWN post-execution hook quiet
      // about an outcome that is nobody's failure, not what decides whether
      // any individual caller's give-up gets reported.
      release: (): boolean => {
        if (released) return false
        released = true
        held.refs--
        if (held.refs <= 0 && !held.controller.signal.aborted) {
          // The shared controller's abort reason answers exactly one
          // question: why did the OPERATION end? The answer here is always
          // the same — nobody is waiting on it any more — so the reason is
          // always ABANDONED, never the reason of whichever caller happened
          // to release last.
          //
          // Each caller's own Result is classified separately, at the share
          // site, from that caller's own `perCaller.reason`. Conflating the
          // two is what made a single shared timeout report twice: the last
          // caller's reason travelled into the shared request, whose
          // post-execution hook then reported it again as an operation
          // failure. Keeping them apart is what lets that hook recognise
          // abandonment (`isAbandoned`) and stay silent.
          held.controller.abort(ABANDONED)
          return true
        }
        return false
      },
    }
  }
}
