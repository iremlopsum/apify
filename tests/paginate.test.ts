import { describe, it, expect } from 'vitest'
import { paginate } from '../src/paginate.js'
import { successResult, errorResult } from '../src/testing.js'
import type { Result, CallOptions } from '../src/types.js'

interface Page { items: number[]; cursor: string | null }
type Params = { limit: number; cursor?: string }

/**
 * A fake endpoint serving a fixed list of pages, recording the params and
 * options it was called with. A real `createApi` method is a function of
 * exactly this shape — `paginate` never needs more than that.
 *
 * Results come from `successResult`/`errorResult`, the library's own `./testing`
 * helpers, rather than hand-built literals: a literal needs casts to satisfy
 * `Result`, and a cast is how a test ends up asserting against a shape the
 * library does not actually produce.
 *
 * Asking for a page past the end yields a 404 rather than `undefined` data, so
 * an over-fetching loop fails on the call-count assertion instead of crashing
 * inside `next` with a TypeError that says nothing about the real bug.
 */
function fakeEndpoint(pages: Page[]) {
  const calls: Array<{ params: Params; options?: CallOptions }> = []
  const endpoint = async (params: Params, options?: CallOptions): Promise<Result<Page>> => {
    calls.push({ params, options })
    const index = params.cursor ? Number(params.cursor) : 0
    const page = pages[index]
    return page ? successResult(page) : errorResult<Page>(404)
  }
  return { endpoint, calls }
}

/** Advances while the page reports a cursor. The canonical `next`. */
const byCursor = (page: { data: Page }, prev: Params): Params | undefined =>
  page.data.cursor ? { ...prev, cursor: page.data.cursor } : undefined

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const value of gen) out.push(value)
  return out
}

describe('paginate', () => {
  it('yields a single page when next returns nothing', async () => {
    const { endpoint, calls } = fakeEndpoint([{ items: [1], cursor: null }])
    const pages = await collect(paginate(endpoint, { limit: 1 }, { next: byCursor }))
    expect(pages).toHaveLength(1)
    expect(pages[0].data).toEqual({ items: [1], cursor: null })
    expect(calls).toHaveLength(1)
  })

  it('walks every page and stops when the cursor runs out', async () => {
    const { endpoint, calls } = fakeEndpoint([
      { items: [1], cursor: '1' },
      { items: [2], cursor: '2' },
      { items: [3], cursor: null },
    ])
    const pages = await collect(paginate(endpoint, { limit: 1 }, { next: byCursor }))
    expect(pages.map(p => p.data?.items)).toEqual([[1], [2], [3]])
    // Exactly three calls — not four. Fetching one page past the end is the
    // classic paging bug and is invisible unless the call count is asserted:
    // the collected items are identical either way.
    expect(calls).toHaveLength(3)
  })

  it('passes the params next returned to the following call', async () => {
    const { endpoint, calls } = fakeEndpoint([
      { items: [1], cursor: '1' },
      { items: [2], cursor: null },
    ])
    await collect(paginate(endpoint, { limit: 7 }, { next: byCursor }))
    expect(calls[0].params).toEqual({ limit: 7 })
    // The spread in `next` is what carries `limit` forward — this pins that the
    // helper does not reconstruct params itself.
    expect(calls[1].params).toEqual({ limit: 7, cursor: '1' })
  })

  it('yields an error page and then stops', async () => {
    const calls: Params[] = []
    const endpoint = async (params: Params): Promise<Result<Page>> => {
      calls.push(params)
      return calls.length === 2
        ? errorResult<Page>(500)
        : successResult<Page>({ items: [1], cursor: '1' })
    }
    const pages = await collect(paginate(endpoint, { limit: 1 }, { next: byCursor }))
    expect(pages).toHaveLength(2)
    expect(pages[0].error).toBeNull()
    expect(pages[1].error).not.toBeNull()
    // Stopped: an error page carries no data, so there are no next params to
    // build. A third call would mean the loop invented one.
    expect(calls).toHaveLength(2)
  })

  it('lets a throwing next propagate rather than swallowing it', async () => {
    // D6: `next` is the caller's own function, running in their own loop. A
    // Result here would need a `kind` that fits nothing and would hide the
    // stack that identifies the bug.
    const { endpoint } = fakeEndpoint([{ items: [1], cursor: '1' }])
    const gen = paginate(endpoint, { limit: 1 }, {
      next: () => { throw new Error('next exploded') },
    })
    await expect(collect(gen)).rejects.toThrow('next exploded')
  })
})
