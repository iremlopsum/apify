import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

describe('unresolved path param surfaces as a Result', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.restoreAllMocks())

  it('returns a network-error Result instead of throwing', async () => {
    const api = createApi({
      baseUrl: '/api',
      requests: { getUser: new Request<{ id: string }, unknown>({ method: 'GET', path: '/users/:userId' }) },
    })
    const r = await api.getUser({ id: '42' })
    expect(r.error).not.toBeNull()
    expect(r.error!.status).toBe(0)
    expect(String(r.error!.body)).toContain(':userId')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports a properly joined URL in the error metadata', async () => {
    // The synchronous catch builds its own URL because buildUrl never
    // returned one. It used to concatenate naively, reproducing the double
    // slash in the very error that describes the failure.
    const api = createApi({
      baseUrl: 'https://x.com/',
      requests: { health: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/health' }) },
    })
    const r = await api.health({ nested: { a: 1 } } as never)
    expect(r.error).not.toBeNull()
    expect(r.error!.request.url).toBe('https://x.com/health')
  })
})
