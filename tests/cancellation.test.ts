// =============================================================================
// cancellation.test.ts — Tests for request cancellation and dedupe integration
// =============================================================================
//
// These tests verify two related features:
//
// 1. **Manual cancellation** — The caller can pass an AbortSignal to cancel a
//    request. When the signal fires, fetch throws a DOMException with name
//    'AbortError', and the result contains an error with status 0.
//
// 2. **Automatic deduplication** — When a Request has `dedupe: true`, firing a
//    new request for the same endpoint automatically cancels any previous
//    in-flight request. This prevents stale responses from overwriting fresh
//    data (e.g., search-as-you-type, rapidly changing filters).
//
// The dedupe tests require careful mock setup: the first fetch call must
// actually listen for the abort event on the signal and reject with a
// DOMException when it fires. A simple "pending promise" won't work because
// the promise would never settle, and the test would hang.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

// ---------------------------------------------------------------------------
// Global mock for fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// =============================================================================
// Manual cancellation tests
// =============================================================================

describe('cancellation', () => {
  it('forwards signal to fetch and returns abort error', async () => {
    // When the caller provides an already-aborted signal, the fetch mock
    // rejects with a DOMException (mimicking real fetch behavior).
    // The result should have data=null, response=null (no HTTP response),
    // and error with status 0 and the DOMException as the body.
    const getItems = new Request<Record<string, never>, unknown>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    // Simulate what real fetch does when it receives an aborted signal:
    // it rejects with a DOMException named 'AbortError'
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
    const controller = new AbortController()
    controller.abort()

    const { data, error, response } = await api.getItems({}, { signal: controller.signal })

    // Verify the result shape matches the network error pattern
    expect(data).toBeNull()
    expect(response).toBeNull()
    expect(error!.status).toBe(0)
    // The error body should be the original DOMException for debugging
    expect(error!.body).toBeInstanceOf(DOMException)
  })
})

// =============================================================================
// Dedupe integration tests
// =============================================================================

describe('dedupe', () => {
  it('auto-cancels previous in-flight request when dedupe is enabled', async () => {
    // This is the core dedupe scenario: two requests for the same endpoint
    // are fired in quick succession. The first should be auto-cancelled
    // (its signal aborted), and only the second should complete successfully.
    //
    // The mock for the first call must listen for the abort event on the
    // signal and reject with DOMException. If we just returned a never-settling
    // promise, the test would hang because nothing would resolve the first call.
    const getItems = new Request<{ page: number }, string[]>({
      method: 'GET',
      path: '/items',
      dedupe: true
    })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    // First call: the mock respects the abort signal.
    // When dedupe aborts the signal, this promise rejects with AbortError.
    // This mimics how a real fetch behaves when its signal is aborted.
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          // Check if the signal is already aborted (edge case: dedupe happened
          // synchronously before this mock even ran)
          if (init.signal) {
            if (init.signal.aborted) {
              return reject(new DOMException('The operation was aborted.', 'AbortError'))
            }
            // Listen for future abort — this is the normal path where the second
            // call triggers dedupe abort while the first is still in-flight
            init.signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'))
              },
              { once: true }
            )
          }
          // Note: we intentionally do NOT call resolve() — this simulates a
          // slow request that would eventually respond, but gets aborted first
        })
    )

    // Second call: resolves immediately with data
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(['b']), { status: 200 }))

    // Fire both calls without awaiting — simulates rapid successive calls
    const first = api.getItems({ page: 1 })
    const second = api.getItems({ page: 2 })

    // The second call should succeed with its data
    const secondResult = await second
    expect(secondResult.data).toEqual(['b'])

    // The first call should have been aborted by dedupe
    const firstResult = await first
    expect(firstResult.error).not.toBeNull()
    expect(firstResult.error!.status).toBe(0)
  })

  it('does not dedupe when dedupe is disabled', async () => {
    // When dedupe is false (or not set), all concurrent requests for the same
    // endpoint should complete independently. No request should be cancelled.
    const getItems = new Request<{ page: number }, string[]>({
      method: 'GET',
      path: '/items',
      dedupe: false
    })
    const api = createApi({ baseUrl: '/api', requests: { getItems } })

    // Both calls return the same data — use mockResolvedValueOnce for each
    // because Response bodies can only be consumed once (response.text() reads
    // the stream). Using mockResolvedValue would share one Response across both
    // calls, causing the second read to fail.
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(['ok']), { status: 200 }))
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(['ok']), { status: 200 }))

    // Fire both calls concurrently — both should succeed
    const [first, second] = await Promise.all([api.getItems({ page: 1 }), api.getItems({ page: 2 })])

    expect(first.data).toEqual(['ok'])
    expect(second.data).toEqual(['ok'])
    // Neither should have been cancelled
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
  })
})
