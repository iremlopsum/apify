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
//   1. Before fetching: `const signal = tracker.track(requestKey, callerSignal?)`
//   2. Pass `signal` to the fetch call
//   3. After fetch completes (success or error): `tracker.clear(requestKey)`
//
// The Map is never unbounded because clear() is called after every request
// completes, keeping the Map size proportional to the number of CONCURRENT
// in-flight requests (typically very small).
// =============================================================================

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
 * const signal1 = tracker.track('searchUsers')
 * fetch('/api/users?q=he', { signal: signal1 })
 *
 * // User types another character — second search request
 * const signal2 = tracker.track('searchUsers')
 * // signal1 is now aborted, the first fetch will throw AbortError
 * fetch('/api/users?q=hel', { signal: signal2 })
 *
 * // After the second fetch completes:
 * tracker.clear('searchUsers')
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
   * @returns An AbortSignal that the fetch call should use. This signal will
   *   be aborted if either (a) a newer request starts for the same key, or
   *   (b) the external signal aborts.
   */
  track(key: string, externalSignal?: AbortSignal): AbortSignal {
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
    // We need to propagate its abort to our internal controller so that the
    // fetch is cancelled from the caller's perspective too.
    //
    // Two cases to handle:
    // a) The external signal is ALREADY aborted — abort immediately
    // b) The external signal is NOT yet aborted — listen for the abort event
    if (externalSignal) {
      if (externalSignal.aborted) {
        // Case (a): The caller's signal was already aborted before we even
        // started. This can happen if a component unmounted between the time
        // the API call was queued and when it actually starts executing.
        // We abort immediately — no point starting a fetch that's DOA.
        controller.abort()
      } else {
        // Case (b): The caller's signal is still active. Set up a one-time
        // listener so that when it aborts in the future, our controller
        // also aborts. Using { once: true } ensures the listener is cleaned
        // up automatically after firing, preventing memory leaks.
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    // Return the signal (not the controller) — the caller only needs to
    // observe abort status, not trigger it. Only the tracker controls when
    // this signal aborts (via dedupe logic or external signal propagation).
    return controller.signal
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
   */
  clear(key: string): void {
    // Simply remove the entry. We don't abort because the request already
    // completed — aborting a finished request has no effect, and we don't
    // want to trigger any abort event listeners that might still be attached.
    this.controllers.delete(key)
  }
}
