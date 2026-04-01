import { describe, it, expect } from 'vitest'
import { Request } from '../src/request.js'

describe('Request', () => {
  it('stores config properties', () => {
    const req = new Request<{ id: string }, { name: string }>({
      method: 'GET',
      path: '/items/:id'
    })

    expect(req.config.method).toBe('GET')
    expect(req.config.path).toBe('/items/:id')
    expect(req.config.responseType).toBeUndefined()
  })

  it('defaults responseType to undefined (json is applied at fetch time)', () => {
    const req = new Request<Record<string, never>, string>({
      method: 'GET',
      path: '/health',
      responseType: 'text'
    })

    expect(req.config.responseType).toBe('text')
  })

  it('stores middleware and headers', () => {
    const mw = async (_ctx: unknown, next: () => Promise<unknown>) => next()
    const req = new Request<Record<string, never>, unknown>({
      method: 'POST',
      path: '/items',
      middleware: [mw as any],
      headers: { 'X-Custom': 'value' }
    })

    expect(req.config.middleware).toHaveLength(1)
    expect(req.config.headers).toEqual({ 'X-Custom': 'value' })
  })

  it('stores dedupe and bodyAs config', () => {
    const req = new Request<{ ids: string[] }, { deleted: number }>({
      method: 'DELETE',
      path: '/items',
      dedupe: true,
      bodyAs: 'body'
    })

    expect(req.config.dedupe).toBe(true)
    expect(req.config.bodyAs).toBe('body')
  })

  it('determines if params should be serialized as query', () => {
    const getReq = new Request<{ page: number }, unknown>({ method: 'GET', path: '/items' })
    const deleteReq = new Request<{ id: string }, unknown>({ method: 'DELETE', path: '/items/:id' })
    const postReq = new Request<{ name: string }, unknown>({ method: 'POST', path: '/items' })
    const deleteBodyReq = new Request<{ ids: string[] }, unknown>({
      method: 'DELETE',
      path: '/items',
      bodyAs: 'body'
    })

    expect(getReq.shouldSerializeAsQuery).toBe(true)
    expect(deleteReq.shouldSerializeAsQuery).toBe(true)
    expect(postReq.shouldSerializeAsQuery).toBe(false)
    expect(deleteBodyReq.shouldSerializeAsQuery).toBe(false)
  })
})
