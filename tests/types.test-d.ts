import { describe, it, expectTypeOf } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { MiddlewareContext, CallOptions } from '../src/types.js'
import type { ApiErrorKind } from '../src/types.js'

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

  it('accepts timeout and skipMiddleware on CallOptions', () => {
    // Both were added to CallOptions by 2.2.0 but neither had a type-level
    // assertion, so either could be dropped without a single test noticing.
    const options: CallOptions = { timeout: 5_000, skipMiddleware: [] }
    expectTypeOf(options.timeout).toEqualTypeOf<number | undefined>()
    expectTypeOf(api.getUser).toBeCallableWith({ id: '1' }, { timeout: 5_000 })
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

describe('ApiErrorKind', () => {
  it('covers every category the library can produce', () => {
    expectTypeOf<ApiErrorKind>().toEqualTypeOf<
      'http' | 'network' | 'abort' | 'timeout' | 'parse' | 'middleware'
    >()
  })
})

describe('Result narrows like a discriminated union', () => {
  it('narrows data after an early return on error', async () => {
    const { data, error } = await api.getUser({ id: '1' })
    if (error) return
    expectTypeOf(data).toEqualTypeOf<User>()
  })

  it('narrows in both directions on an explicit null check', async () => {
    const r = await api.getUser({ id: '1' })
    if (r.error === null) expectTypeOf(r.data).toEqualTypeOf<User>()
    else expectTypeOf(r.data).toEqualTypeOf<null>()
  })

  it('gives a non-null Response on the success branch', async () => {
    const r = await api.getUser({ id: '1' })
    if (r.error) return
    expectTypeOf(r.response).toEqualTypeOf<Response>()
  })
})

describe('Request generics are not structurally interchangeable', () => {
  it('rejects a Request with different generics', () => {
    interface Post { slug: string }
    const getPost = new Request<{ slug: string }, Post>({ method: 'GET', path: '/posts/:slug' })
    // @ts-expect-error — a Post request is not a User request
    const wrong: Request<{ id: string }, User> = getPost
    void wrong
  })

  it('still infers params and response through createApi', async () => {
    const r = await api.getUser({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })
})
