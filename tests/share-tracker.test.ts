import { describe, it, expect, vi } from 'vitest'
import { ShareTracker, isAbandoned } from '../src/utils/share.js'

const never = () => new Promise<never>(() => {})

describe('ShareTracker abandonment', () => {
  it('aborts with an abandonment reason when the last reference releases', async () => {
    const t = new ShareTracker()
    let seen: AbortSignal | undefined
    const { release } = t.acquire('k', s => { seen = s; return never() })
    expect(release()).toBe(true)
    expect(seen!.aborted).toBe(true)
    expect(isAbandoned(seen!.reason)).toBe(true)
  })

  it('does not report abandonment for a non-last release', () => {
    const t = new ShareTracker()
    const a = t.acquire('k', () => never())
    const b = t.acquire('k', () => never())
    expect(a.release()).toBe(false)
    expect(b.release()).toBe(true)
  })

  it('treats an abandoned entry as absent immediately, not a microtask later', () => {
    const t = new ShareTracker()
    let calls = 0
    const first = t.acquire('k', () => { calls++; return never() })
    first.release()
    // No await: the previous entry is dead but its .finally() has not run.
    t.acquire('k', () => { calls++; return never() })
    expect(calls).toBe(2)
  })

  it('a double release returns false the second time', () => {
    const t = new ShareTracker()
    const { release } = t.acquire('k', () => never())
    expect(release()).toBe(true)
    expect(release()).toBe(false)
  })

  it('isAbandoned rejects ordinary abort reasons', () => {
    expect(isAbandoned(new DOMException('x', 'AbortError'))).toBe(false)
    expect(isAbandoned(new DOMException('x', 'TimeoutError'))).toBe(false)
    expect(isAbandoned(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task 9 fix round 1, Finding 1: create-api.ts's share site has two rejection
// handlers on the promise `ShareTracker.acquire` returns —
//
//   src/create-api.ts:987  (no-`perCaller` fast path)
//     if (!perCaller) return promise.then(r => r, (err) => failedResult(err, 'network'))
//
//   src/create-api.ts:1002-1026 (per-caller race's rejection arm, "Fix 2, 2.2.1")
//     promise.then(r => finish(r), (err) => { if (done) return; finish(failedResult(err, 'network')) })
//
// Since Task 9, `execute()` converts a middleware rejection into a Result
// *before* it can ever reach `ShareTracker`'s `promise`, so neither handler
// has a live producer through the public `createApi` surface any more — a
// reviewer proved this by deleting both outright and finding the full suite
// (294/294) still green. They are kept as defense-in-depth (the "execute
// never rejects" invariant lives in code, not in types), which means they
// need a pin that does not depend on that invariant holding.
//
// `ShareTracker.acquire`'s `exec` parameter is the seam: it accepts any
// `(signal, markSettled) => Promise<Result>`, so a test can hand it a
// promise that genuinely rejects, bypassing `execute()` (and the rest of
// `createApi`) entirely. create-api.ts's two handlers are not exported (they
// are inline in a per-method closure), so the tests below reproduce them
// verbatim against a real `ShareTracker` — this is the executable spec for
// logic that can no longer be exercised end-to-end, not a duplicate of an
// importable function. Each test's own reproduction is what gets
// revert-verified (comment out the mirrored line, confirm the test fails,
// restore) — see task-9-report.md for both transcripts.
// ---------------------------------------------------------------------------
describe('share site rejection handling (defense-in-depth pin, Task 9 fix round 1)', () => {
  /** Stand-in for create-api.ts's `buildFailedResult` — construction only. */
  function buildFailedResult(reason: unknown, kind: 'abort' | 'network') {
    return { data: null, error: { kind, body: reason } }
  }

  it('no-perCaller fast path: a rejecting exec still resolves to a Result (mirrors create-api.ts:987)', async () => {
    const tracker = new ShareTracker()
    const { promise } = tracker.acquire('k1', async () => { throw new Error('middleware exploded') })

    // Mirrors: if (!perCaller) return promise.then(r => r, (err) => failedResult(err, 'network'))
    const result = await promise.then(r => r, (err: unknown) => buildFailedResult(err, 'network'))

    expect(result.error).not.toBeNull()
    expect(result.error!.kind).toBe('network')
    expect((result.error!.body as Error).message).toBe('middleware exploded')
  })

  it('per-caller race: the done-bail stops a caller that already gave up from being reported twice (mirrors create-api.ts:1002-1026, 1055-1063)', async () => {
    const tracker = new ShareTracker()
    const reports: { kind: string }[] = []
    let rejectExec: (err: unknown) => void = () => {}
    const { promise, release, hasSettled } = tracker.acquire('k2', () =>
      new Promise<never>((_resolve, reject) => { rejectExec = reject })
    )

    const perCaller = new AbortController()

    const result = await new Promise<{ error: { kind: string } | null }>(resolve => {
      let done = false
      const finish = (r: { error: { kind: string } | null }): void => {
        if (done) return
        done = true
        perCaller.signal.removeEventListener('abort', onAbort)
        resolve(r)
      }

      promise.then(
        r => finish(r as { error: { kind: string } | null }),
        (err: unknown) => {
          // Mirrors the "Fix 2" done-bail at create-api.ts:1024-1025 exactly:
          if (done) return
          const built = buildFailedResult(err, 'network')
          reports.push(built.error)
          finish(built)
        }
      )

      // Mirrors create-api.ts's onAbort at :1055-1063.
      const onAbort = (): void => {
        release()
        const built = buildFailedResult(perCaller.signal.reason, 'abort')
        if (!hasSettled()) reports.push(built.error)
        finish(built)
      }

      perCaller.signal.addEventListener('abort', onAbort, { once: true })

      // This caller gives up first, while the shared operation is still
      // pending (hasSettled() is false) — a genuine give-up, reported once.
      perCaller.abort(new Error('gave up'))
      // The shared operation rejects afterward. Without the done-bail this
      // would report a second time, under a different kind ('network'),
      // for a caller that already has its Result.
      queueMicrotask(() => rejectExec(new Error('middleware exploded')))
    })

    // The outer promise (this caller's Result) settles the instant onAbort
    // calls finish(), one microtask hop after `perCaller.abort()`. The
    // rejection handler's chain — exec's raw promise -> ShareTracker's
    // `.finally()` -> this test's `promise.then(...)` — needs more hops than
    // that, so `result` above is already resolved before the rejection
    // handler (bail or no bail) has even run. A macrotask flush is what
    // create-api.ts's own tests use for the identical reason
    // (`tests/share.test.ts`'s `flush`) — without it, this test would pass
    // regardless of whether the done-bail exists, since it would assert on
    // `reports` before the vestigial handler had a chance to push into it.
    await new Promise(r => setTimeout(r, 0))

    expect(result.error!.kind).toBe('abort')
    expect(reports.map(r => r.kind)).toEqual(['abort']) // not ['abort', 'network']
  })
})
