import { describe, it, expect } from 'vitest'
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
})
