// =============================================================================
// dedupe.ts — Deduplication tracker for in-flight API requests
// =============================================================================
//
// Problem this solves:
//
// When the same API request is fired multiple times in rapid succession (e.g.,
// a search-as-you-type input, or a user spam-clicking a button), we typically
// only care about the LATEST request's response. Previous in-flight requests
// become stale — their responses would overwrite newer data if they arrive late.
//
// Solution:
//
// DedupeTracker maintains a Map of AbortControllers keyed by request name.
// When a new request starts for a key that already has an in-flight request,
// the previous request's AbortController is aborted, which causes the fetch
// to throw an AbortError. The caller (middleware or createApi) catches this
// error and discards the stale response.
//
// Additionally, the tracker supports merging with an external AbortSignal
// (e.g., one provided by the caller via CallOptions.signal). This allows
// cancellation to flow from BOTH directions:
//   - Internally: dedupe logic aborts when a newer request starts
//   - Externally: caller aborts (e.g., component unmounts, timeout fires)
//
// Usage flow:
//   1. Before fetching: `const { signal, controller } = tracker.track(requestKey, callerSignal?)`
//   2. Pass `signal` to the fetch call
//   3. After fetch completes (success or error): `tracker.clear(requestKey, controller)`
//
// The Map is never unbounded because clear() is called after every request
// completes, keeping the Map size proportional to the number of CONCURRENT
// in-flight requests (typically very small).
//
// clear() takes the controller returned by the matching track() call so it can
// verify it still owns the map entry before deleting it. Without that check, a
// superseded request that settles late would delete the entry belonging to
// whichever newer request replaced it — see clear()'s doc comment below.
// =============================================================================

import { anySignal } from './any-signal.js'

/**
 * Tracks in-flight requests by key and auto-aborts previous calls when a new
 * one starts for the same key. This prevents stale responses from overwriting
 * fresh data in race condition scenarios.
 *
 * The class is intentionally simple — it's a thin wrapper around a Map of
 * AbortControllers. The complexity lives in the signal merging logic within
 * `track()`, which ensures both internal (dedupe) and external (caller)
 * abort signals are respected.
 *
 * @example
 * ```ts
 * const tracker = new DedupeTracker()
 *
 * // First search request
 * const first = tracker.track('searchUsers')
 * fetch('/api/users?q=he', { signal: first.signal })
 *
 * // User types another character — second search request
 * const second = tracker.track('searchUsers')
 * // first.signal is now aborted, the first fetch will throw AbortError
 * fetch('/api/users?q=hel', { signal: second.signal })
 *
 * // After the second fetch completes, pass its controller back so clear()
 * // can confirm it still owns the entry before deleting it:
 * tracker.clear('searchUsers', second.controller)
 * ```
 */
export class DedupeTracker {
  /**
   * Internal storage mapping request keys to their AbortControllers.
   *
   * We store AbortControllers (not AbortSignals) because we need the ability
   * to call `.abort()` on them when a newer request arrives. The signal is
   * derived from the controller and returned to the caller.
   *
   * The Map is keyed by string (typically the request name like 'getUser' or
   * 'searchItems') so that each unique request type has its own dedupe lane.
   */
  private controllers = new Map<string, AbortController>()

  /**
   * Start tracking a request by key. If a previous request is already being
   * tracked under the same key, its AbortController is aborted — causing the
   * previous fetch to throw an AbortError.
   *
   * A fresh AbortController is created for the new request and stored in the
   * Map. If an external AbortSignal is provided (from the caller's
   * CallOptions), it is merged so that aborting the external signal also
   * aborts the dedupe signal.
   *
   * @param key - Unique identifier for the request type. Two calls with the
   *   same key are considered "the same request" for deduplication purposes.
   *   Typically this is the request definition's name (e.g., 'getUser').
   * @param externalSignal - Optional AbortSignal from the caller. When this
   *   signal aborts, the dedupe signal will also abort. This enables the
   *   caller to cancel the request independently of the dedupe logic (e.g.,
   *   on component unmount or timeout).
   * @returns The `signal` the fetch call should use — aborted if either (a) a
   *   newer request starts for the same key, or (b) the external signal
   *   aborts — alongside the `controller` that owns it, which the caller must
   *   pass back to `clear()` to prove ownership of the map entry.
   */
  track(key: string, externalSignal?: AbortSignal): { signal: AbortSignal; controller: AbortController } {
    // -------------------------------------------------------------------------
    // Step 1: Abort any existing in-flight request for this key
    // -------------------------------------------------------------------------
    // If there's already a controller stored for this key, it means a previous
    // request is still in flight. We abort it because the new request supersedes
    // it — the previous response is now stale and should be discarded.
    const existing = this.controllers.get(key)
    if (existing) existing.abort()

    // -------------------------------------------------------------------------
    // Step 2: Create a fresh AbortController for the new request
    // -------------------------------------------------------------------------
    // This controller's signal will be returned to the caller and passed to
    // fetch(). Storing the controller (not the signal) allows us to abort it
    // later when either a newer request arrives or the external signal fires.
    const controller = new AbortController()
    this.controllers.set(key, controller)

    // -------------------------------------------------------------------------
    // Step 3: Merge with external signal (if provided)
    // -------------------------------------------------------------------------
    // The external signal comes from the caller (e.g., CallOptions.signal).
    // Merge the caller's signal so cancellation flows from both directions:
    // this tracker aborts when a newer request supersedes, and the caller's
    // own signal aborts when they give up. anySignal carries the reason
    // through, so a TimeoutError does not degrade into a plain AbortError.
    const signal = anySignal([controller.signal, externalSignal]) ?? controller.signal

    // Return the controller alongside the signal so the caller can pass it
    // back to clear() and prove ownership — see clear()'s identity check.
    return { signal, controller }
  }

  /**
   * Stop tracking a request after it completes (either successfully or with
   * an error). This removes the AbortController from the internal Map.
   *
   * **Important:** This does NOT abort the controller — the request has already
   * finished, so aborting would be pointless. It simply cleans up the Map entry
   * so that the next call to `track()` for the same key starts fresh without
   * unnecessarily aborting a completed request.
   *
   * @param key - The same key that was passed to `track()`. If the key doesn't
   *   exist in the Map (e.g., it was already cleared or never tracked), this
   *   is a no-op — Map.delete() on a missing key does nothing.
   * @param controller - Optional: the controller returned by the `track()`
   *   call this clear() corresponds to. When provided, the entry is only
   *   deleted if it still belongs to that exact controller — otherwise a
   *   superseded (and now-stale) request's cleanup would delete the entry
   *   belonging to whichever newer request replaced it. Omitting it preserves
   *   the old unconditional-delete behaviour.
   */
  clear(key: string, controller?: AbortController): void {
    // Only the request that registered this controller may clear it. Without
    // this check a superseded request settling late would delete the entry
    // belonging to the request that superseded it, silently disabling dedupe
    // from the second cancellation onward.
    if (controller && this.controllers.get(key) !== controller) return
    this.controllers.delete(key)
  }
}
