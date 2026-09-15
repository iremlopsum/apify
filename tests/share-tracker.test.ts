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
