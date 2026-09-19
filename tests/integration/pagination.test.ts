import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createApi } from '../../src/create-api.js'
import { Request } from '../../src/request.js'
import { paginate } from '../../src/paginate.js'
import { startServer, type TestServer } from './server.js'

interface Page { items: number[]; cursor: string | null }
type Params = { cursor?: string }

let server: TestServer

beforeAll(async () => { server = await startServer() })
afterAll(async () => { await server.close() })
afterEach(() => { server.callCounts.clear() })

describe('pagination over real HTTP', () => {
  const client = () => createApi({
    baseUrl: server.baseUrl,
    requests: { pages: new Request<Params, Page>({ method: 'GET', path: '/pages' }) },
  })

  const byCursor = (page: { data: Page }, prev: Params): Params | undefined =>
    page.data.cursor ? { ...prev, cursor: page.data.cursor } : undefined

  it('walks every page and makes exactly one request per page', async () => {
    const items: number[] = []
    for await (const page of paginate(client().pages, {}, { next: byCursor })) {
      expect(page.error).toBeNull()
      if (page.data) items.push(...page.data.items)
    }
    expect(items).toEqual([0, 1, 2, 3, 4, 5])
    // The assertion the unit tests cannot make. A loop that fetches one page
    // past the end still collects exactly the right items — only the count
    // catches it.
    expect(server.callCounts.get('GET /pages')).toBe(3)
  })

  it('stops at maxPages without making the later requests', async () => {
    const items: number[] = []
    for await (const page of paginate(client().pages, {}, { next: byCursor, maxPages: 2 })) {
      if (page.data) items.push(...page.data.items)
    }
    expect(items).toEqual([0, 1, 2, 3])
    expect(server.callCounts.get('GET /pages')).toBe(2)
  })

  it('an aborted signal ends the crawl and yields the abort', async () => {
    const controller = new AbortController()
    const seen: Array<{ ok: boolean }> = []
    for await (const page of paginate(client().pages, {}, { next: byCursor, signal: controller.signal })) {
      seen.push({ ok: page.error === null })
      controller.abort()
    }
    // First page succeeds; the second is attempted, rejected by the already
    // aborted signal, yielded as an error, and ends the walk.
    expect(seen).toEqual([{ ok: true }, { ok: false }])
    // ONE request, not two: the signal reaches the second call and stops it
    // before it hits the network. That is the assertion worth making — it is
    // what proves CallOptions are passed to every page and not just the first.
    expect(server.callCounts.get('GET /pages')).toBe(1)
  })
})
