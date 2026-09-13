import { describe, it, expectTypeOf } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { MiddlewareContext, CallOptions } from '../src/types.js'

interface User { id: string; name: string }

const api = createApi({
  baseUrl: '/api',
  requests: {
    getUser: new Request<{ id: string }, User>({ method: 'GET', path: '/users/:id' }),
    health: new Request<Record<string, never>, { ok: boolean }>({ method: 'GET', path: '/health' }),
  },
})

describe('public type surface', () => {
  it('infers params and response from Request generics', async () => {
    const r = await api.getUser({ id: '1' })
    expectTypeOf(r.data).toEqualTypeOf<User | null>()
  })

  it('makes params optional for a no-param endpoint', () => {
    expectTypeOf(api.health).parameters.toMatchTypeOf<[({} | undefined)?, (CallOptions | undefined)?]>()
  })

  it('lets a consumer construct a MiddlewareContext without every optional field', () => {
    // This is the 2.1.0 regression: `signal` was briefly REQUIRED, so this
    // literal stopped compiling for anyone unit-testing their own middleware.
    const ctx: MiddlewareContext = {
      request: {
        method: 'GET',
        url: '/test',
        path: '/test',
        params: {},
        headers: new Headers(),
        body: null,
      },
      requestName: 'test',
    }
    expectTypeOf(ctx.requestName).toEqualTypeOf<string>()
  })
})
