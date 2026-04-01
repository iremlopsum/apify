// =============================================================================
// dedupe.test.ts — Tests for the DedupeTracker utility
// =============================================================================
//
// DedupeTracker solves a common problem in API clients: when the same request
// is fired multiple times in quick succession (e.g., user rapidly clicking a
// button, or a search-as-you-type input), previous in-flight requests should
// be cancelled so that only the latest one completes.
//
// These tests verify:
// 1. Basic tracking returns a usable AbortSignal
// 2. Same-key tracking aborts the previous signal (the core dedupe behavior)
// 3. Different keys are independent and don't interfere
// 4. Clearing a key removes it from tracking (no stale aborts)
// 5. Merging with an already-aborted external signal propagates immediately
// 6. Merging with an external signal that aborts later propagates the abort
// =============================================================================

import { describe, it, expect } from 'vitest'
import { DedupeTracker } from '../src/utils/dedupe.js'

describe('DedupeTracker', () => {
  it('returns a new AbortSignal on first call', () => {
    const tracker = new DedupeTracker()
    const signal = tracker.track('req1')

    // The first call for any key should produce a fresh, non-aborted signal.
    // This signal is what the fetch call will use to know if it should cancel.
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
  })

  it('aborts the previous signal when tracking the same key', () => {
    const tracker = new DedupeTracker()

    // Simulate two rapid calls for the same request key (e.g., user typed
    // two characters quickly in a search box, triggering two API calls)
    const first = tracker.track('req1')
    const second = tracker.track('req1')

    // The first request's signal should now be aborted — the fetch using it
    // will throw an AbortError, which the caller can handle gracefully
    expect(first.aborted).toBe(true)

    // The second (newest) request should still be active
    expect(second.aborted).toBe(false)
  })

  it('does not affect signals for different keys', () => {
    const tracker = new DedupeTracker()

    // Different request keys represent entirely separate API endpoints
    // or request types — they should never interfere with each other
    const a = tracker.track('req1')
    const b = tracker.track('req2')

    // Both should remain active because they are independent
    expect(a.aborted).toBe(false)
    expect(b.aborted).toBe(false)
  })

  it('clears tracking for a key', () => {
    const tracker = new DedupeTracker()
    const first = tracker.track('req1')

    // After a request completes successfully, the caller should clear the key.
    // This removes the AbortController from the Map, so the next call for the
    // same key won't unnecessarily abort the (already finished) previous request.
    tracker.clear('req1')

    const second = tracker.track('req1')

    // The first signal was NOT aborted — clear() only removes tracking, it
    // does not abort. The request already completed, so aborting would be wrong.
    expect(first.aborted).toBe(false)

    // The second signal is also fresh and active
    expect(second.aborted).toBe(false)
  })

  it('merges with an already-aborted external signal', () => {
    const tracker = new DedupeTracker()

    // AbortSignal.abort() creates a signal that is already in the aborted state.
    // This simulates a scenario where the caller's signal was aborted before
    // the dedupe tracker even gets involved (e.g., a component unmounted).
    const external = AbortSignal.abort()
    const signal = tracker.track('req1', external)

    // The dedupe signal should immediately reflect the external abort — there's
    // no point starting a fetch that's already been cancelled by the caller
    expect(signal.aborted).toBe(true)
  })

  it('aborts dedupe signal when external signal fires later', () => {
    const tracker = new DedupeTracker()

    // Create an external AbortController that the caller controls
    // (e.g., tied to a component lifecycle or a timeout)
    const controller = new AbortController()
    const signal = tracker.track('req1', controller.signal)

    // Initially, neither external nor dedupe signal is aborted
    expect(signal.aborted).toBe(false)

    // When the external signal aborts (e.g., component unmounts), the dedupe
    // signal should also abort — propagating the cancellation to the fetch
    controller.abort()
    expect(signal.aborted).toBe(true)
  })
})
