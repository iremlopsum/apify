import { describe, it, expect, vi } from 'vitest'
import { anySignal } from '../src/utils/any-signal.js'

describe('anySignal', () => {
  it('returns undefined when given nothing', () => {
    expect(anySignal([])).toBeUndefined()
    expect(anySignal([undefined, undefined])).toBeUndefined()
  })

  it('returns the single signal unchanged, allocating no controller', () => {
    const c = new AbortController()
    expect(anySignal([c.signal])).toBe(c.signal)
    expect(anySignal([undefined, c.signal, undefined])).toBe(c.signal)
  })

  it('aborts when the first of several aborts', () => {
    const a = new AbortController(), b = new AbortController()
    const merged = anySignal([a.signal, b.signal])!
    expect(merged.aborted).toBe(false)
    a.abort()
    expect(merged.aborted).toBe(true)
  })

  it('aborts when the second of several aborts', () => {
    const a = new AbortController(), b = new AbortController()
    const merged = anySignal([a.signal, b.signal])!
    b.abort()
    expect(merged.aborted).toBe(true)
  })

  it('preserves the reason, so TimeoutError stays distinguishable', () => {
    const a = new AbortController(), b = new AbortController()
    const merged = anySignal([a.signal, b.signal])!
    b.abort(new DOMException('Timed out', 'TimeoutError'))
    expect((merged.reason as Error).name).toBe('TimeoutError')
  })

  it('is already aborted when an input is already aborted', () => {
    const a = new AbortController()
    a.abort(new DOMException('Aborted', 'AbortError'))
    const merged = anySignal([a.signal, new AbortController().signal])!
    expect(merged.aborted).toBe(true)
    expect((merged.reason as Error).name).toBe('AbortError')
  })

  it('only aborts once when several inputs abort', () => {
    const a = new AbortController(), b = new AbortController()
    const merged = anySignal([a.signal, b.signal])!
    let fired = 0
    merged.addEventListener('abort', () => { fired++ })
    a.abort(new DOMException('first', 'AbortError'))
    b.abort(new DOMException('second', 'AbortError'))
    expect(fired).toBe(1)
    expect((merged.reason as Error).message).toBe('first')
  })

  it('aborts immediately when a later input is already aborted', () => {
    const pending = new AbortController()
    const already = new AbortController()
    already.abort(new DOMException('gone', 'AbortError'))

    const merged = anySignal([pending.signal, already.signal])!

    expect(merged.aborted).toBe(true)
    expect((merged.reason as Error).message).toBe('gone')
  })

  it('ignores a losing input that aborts after the race is decided', () => {
    const winner = new AbortController()
    const loser = new AbortController()
    const merged = anySignal([winner.signal, loser.signal])!

    winner.abort(new DOMException('winner', 'AbortError'))
    const settledReason = merged.reason

    loser.abort(new DOMException('loser', 'AbortError'))
    expect(merged.reason).toBe(settledReason)
  })

  // ---------------------------------------------------------------------------
  // The listener-release fix has no other observable consequence: abortWith's
  // own `if (!controller.signal.aborted)` guard already gives the once-only
  // semantics every behavioural test above asserts, so all of them keep
  // passing with cleanup() neutered. The leak is only visible by watching for
  // the removal itself. It matters because a caller's signal routinely
  // outlives the request by a long way — one component-scoped controller
  // reused across hundreds of calls — and every listener left on it keeps a
  // dead merged controller reachable.
  // ---------------------------------------------------------------------------
  it('removes its listener from the losing signal once the race is decided', () => {
    const a = new AbortController(), b = new AbortController()
    const spy = vi.spyOn(b.signal, 'removeEventListener')

    anySignal([a.signal, b.signal])
    a.abort()

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('removes its listener from every input, including the winner', () => {
    const a = new AbortController(), b = new AbortController()
    const spyA = vi.spyOn(a.signal, 'removeEventListener')
    const spyB = vi.spyOn(b.signal, 'removeEventListener')

    anySignal([a.signal, b.signal])
    b.abort()

    expect(spyA).toHaveBeenCalled()
    expect(spyB).toHaveBeenCalled()
    spyA.mockRestore(); spyB.mockRestore()
  })
})
