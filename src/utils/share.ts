import type { Result } from '../types.js'

interface Entry {
  promise: Promise<Result<unknown>>
  controller: AbortController
  refs: number
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
  ): { promise: Promise<Result<unknown>>; release: (reason?: unknown) => void } {
    let entry = this.inflight.get(key)

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
      release: (reason?: unknown) => {
        if (released) return
        released = true
        held.refs--
        if (held.refs <= 0 && !held.controller.signal.aborted) {
          held.controller.abort(reason)
        }
      },
    }
  }
}
