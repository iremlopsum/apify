import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { retryMiddleware, logMiddleware } from '../src/built-in-middleware.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('retryMiddleware', () => {
  it('retries on 5xx up to maxRetries times', async () => {
    const getItems = new Request<Record<string, never>, string[]>({ method: 'GET', path: '/items' })
    const retry = retryMiddleware(2)
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [retry] })

    // Fail twice, succeed on third
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(['ok']), { status: 200 }))

    const { data, error } = await api.getItems()

    expect(data).toEqual(['ok'])
    expect(error).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('returns error after exhausting retries', async () => {
    const getItems = new Request<Record<string, never>, string[]>({ method: 'GET', path: '/items' })
    const retry = retryMiddleware(1)
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [retry] })

    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))

    const { data, error } = await api.getItems()

    expect(data).toBeNull()
    expect(error!.status).toBe(500)
    expect(mockFetch).toHaveBeenCalledTimes(2) // 1 original + 1 retry
  })

  it('does not retry on 4xx', async () => {
    const getItems = new Request<Record<string, never>, string[]>({ method: 'GET', path: '/items' })
    const retry = retryMiddleware(3)
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [retry] })

    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    const { error } = await api.getItems()

    expect(error!.status).toBe(404)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('logMiddleware', () => {
  it('logs request and response', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const getItems = new Request<Record<string, never>, string[]>({ method: 'GET', path: '/items' })
    const api = createApi({ baseUrl: '/api', requests: { getItems }, middleware: [logMiddleware] })

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
    await api.getItems()

    expect(consoleSpy).toHaveBeenCalled()
    const loggedMessages = consoleSpy.mock.calls.map(c => c.join(' '))
    expect(loggedMessages.some(m => m.includes('getItems'))).toBe(true)
    consoleSpy.mockRestore()
  })
})
