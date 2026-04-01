import { describe, it, expect, vi } from 'vitest'
import { composeMiddleware } from '../src/middleware.js'
import type { Middleware, MiddlewareContext, Result } from '../src/types.js'

/** Helper to create a minimal context. */
function makeContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    request: {
      method: 'GET',
      url: '/test',
      path: '/test',
      params: {},
      headers: new Headers(),
      body: null
    },
    requestName: 'test',
    ...overrides
  }
}

/** Helper to create a terminal result. */
function makeResult<T>(data: T): Result<T> {
  return { data, error: null, response: new Response(), retry: () => Promise.resolve(makeResult(data)) }
}

describe('composeMiddleware', () => {
  it('calls the core function when no middleware is provided', async () => {
    const core = vi.fn().mockResolvedValue(makeResult('ok'))
    const composed = composeMiddleware([], core)
    const result = await composed(makeContext())

    expect(core).toHaveBeenCalledOnce()
    expect(result.data).toBe('ok')
  })

  it('executes middleware in order (onion model)', async () => {
    const order: string[] = []

    const mw1: Middleware = async (ctx, next) => {
      order.push('mw1-before')
      const result = await next()
      order.push('mw1-after')
      return result
    }

    const mw2: Middleware = async (ctx, next) => {
      order.push('mw2-before')
      const result = await next()
      order.push('mw2-after')
      return result
    }

    const core = vi.fn().mockImplementation(async () => {
      order.push('core')
      return makeResult('ok')
    })

    const composed = composeMiddleware([mw1, mw2], core)
    await composed(makeContext())

    expect(order).toEqual(['mw1-before', 'mw2-before', 'core', 'mw2-after', 'mw1-after'])
  })

  it('allows middleware to short-circuit by not calling next', async () => {
    const shortCircuit: Middleware = async () => makeResult('cached') as Result<unknown>
    const core = vi.fn().mockResolvedValue(makeResult('from-server'))

    const composed = composeMiddleware([shortCircuit], core)
    const result = await composed(makeContext())

    expect(result.data).toBe('cached')
    expect(core).not.toHaveBeenCalled()
  })

  it('allows middleware to modify context before next', async () => {
    const authMw: Middleware = async (ctx, next) => {
      ctx.request.headers.set('Authorization', 'Bearer token123')
      return next()
    }

    const core = vi.fn().mockImplementation(async (ctx: MiddlewareContext) => {
      return makeResult(ctx.request.headers.get('Authorization'))
    })

    const composed = composeMiddleware([authMw], core)
    const result = await composed(makeContext())

    expect(core).toHaveBeenCalledOnce()
    const passedCtx = core.mock.calls[0][0] as MiddlewareContext
    expect(passedCtx.request.headers.get('Authorization')).toBe('Bearer token123')
  })

  it('allows middleware to call next() multiple times (for retry)', async () => {
    let callCount = 0
    const retryMw: Middleware = async (ctx, next) => {
      let result = await next()
      if (result.data === 'fail') {
        result = await next()
      }
      return result
    }

    const core = vi.fn().mockImplementation(async () => {
      callCount++
      return callCount === 1 ? makeResult('fail') : makeResult('success')
    })

    const composed = composeMiddleware([retryMw], core)
    const result = await composed(makeContext())

    expect(result.data).toBe('success')
    expect(core).toHaveBeenCalledTimes(2)
  })

  it('skips middleware listed in skipMiddleware', async () => {
    const skipped: Middleware = async (_ctx, next) => {
      throw new Error('should not run')
    }
    const kept: Middleware = async (ctx, next) => next()
    const core = vi.fn().mockResolvedValue(makeResult('ok'))

    const composed = composeMiddleware([skipped, kept], core, [skipped])
    const result = await composed(makeContext())

    expect(result.data).toBe('ok')
  })
})
