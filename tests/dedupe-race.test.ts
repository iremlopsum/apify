import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

function deferredFetch() {
  const calls: { resolve: () => void; aborted: () => boolean }[] = []
  const fn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const signal = init.signal as AbortSignal
    signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))
    calls.push({
      resolve: () => res(new Response('{"ok":1}', { status: 200 })),
      aborted: () => signal.aborted,
    })
  }))
  return { fn, calls }
}

describe('dedupe survives a late-settling superseded request', () => {
  let f: ReturnType<typeof deferredFetch>
  beforeEach(() => { f = deferredFetch(); vi.stubGlobal('fetch', f.fn) })
  afterEach(() => vi.restoreAllMocks())

  it('C aborts B even though A settled after B started', async () => {
    const api = createApi({
      baseUrl: '',
      requests: { search: new Request<{ q: string }, unknown>({ method: 'GET', path: '/s', dedupe: true }) },
    })
    const pA = api.search({ q: 'a' })
    const pB = api.search({ q: 'b' })   // aborts A
    await pA                             // A settles late and must not clear B
    const pC = api.search({ q: 'c' })    // must abort B
    await Promise.resolve(); await Promise.resolve()

    expect(f.calls[1].aborted()).toBe(true)

    f.calls[2].resolve()
    await pC
    await pB.catch(() => {})
  })
})
