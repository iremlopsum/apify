import { describe, it, expectTypeOf } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { MiddlewareContext, CallOptions, RequestConfig } from '../src/types.js'
import type { ApiErrorKind } from '../src/types.js'
import { successResult, errorResult } from '../src/testing.js'
import type { ApiError } from '../src/types.js'
import type { PathParams } from '../src/define-request.js'

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

// These assert the builders' PUBLIC contract — that `Result<T>` narrowing
// still works for consumers. The internal migration to `SuccessResult<T>` /
// `ErrorResult<T>` locals is enforced by `npm run typecheck`, not by these.
describe('testing builders produce valid union members', () => {
  it('successResult is a SuccessResult', () => {
    const r = successResult({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<{ id: string }>()
    expectTypeOf(r.response).toEqualTypeOf<Response>()
  })

  it('errorResult is an ErrorResult', () => {
    const r = errorResult<{ id: string }>(500)
    // errorResult()'s declared return type stays `Result<T>` (a union), so —
    // symmetric with the guard clause above — narrow before asserting.
    if (!r.error) return
    expectTypeOf(r.data).toEqualTypeOf<null>()
    expectTypeOf(r.error).toEqualTypeOf<ApiError>()
  })
})

describe("responseType: 'none'", () => {
  it('gives data type undefined on the success branch', async () => {
    const noneApi = createApi({
      baseUrl: '/api',
      requests: {
        del: new Request<{ id: string }, undefined>({
          method: 'DELETE', path: '/u/:id', responseType: 'none',
        }),
      },
    })
    const r = await noneApi.del({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<undefined>()
  })

  it('still narrows normally for an ordinary request', async () => {
    const r = await api.getUser({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })

  it("does NOT refuse responseType 'none' paired with a declared response body — convention, not a compiler guarantee", () => {
    // A type-level guard here was tried (an overload pair) and dropped: see
    // the JSDoc on `ResponseType` in src/types.ts. TS's overload resolution
    // falls through to the general `RequestConfig` overload for any call a
    // narrower one rejects, so the guard never actually fired. This
    // compiles today; it is a documented convention violation, not a caught
    // one. Do NOT re-add a `// @ts-expect-error` above this — there is
    // nothing here for the compiler to flag.
    new Request<{ id: string }, User>({ method: 'DELETE', path: '/u/:id', responseType: 'none' })
  })

  // Regression coverage for the guard's original break: a `RequestConfig`-
  // typed variable, and a spread of one, must both still construct a
  // `Request` whose `TResponse` is a concrete (non-undefined) type. Both of
  // these failed to compile under the single conditional constructor
  // signature that actually shipped and broke this; the overload pair
  // attempted later silently rejected nothing instead.
  it('accepts a RequestConfig-typed variable even when TResponse is concrete', () => {
    const cfg: RequestConfig = { method: 'GET', path: '/u/:id' }
    const req = new Request<{ id: string }, User>(cfg)
    expectTypeOf(req).toEqualTypeOf<Request<{ id: string }, User>>()
  })

  it('accepts a spread of a RequestConfig-typed variable even when TResponse is concrete', () => {
    const base: RequestConfig = { method: 'GET', path: '/u/:id' }
    const req = new Request<{ id: string }, User>({ ...base, path: '/x' })
    expectTypeOf(req).toEqualTypeOf<Request<{ id: string }, User>>()
  })
})

describe('defineRequest — the path parser', () => {
  it('extracts exactly the tokens buildUrl substitutes', () => {
    // Deliberately duplicates tests/define-request.test.ts's case table. That
    // test proves what the RUNTIME does; this one proves what the TYPE says.
    // A single case table would prove only that a file agrees with itself.
    expectTypeOf<keyof PathParams<'/users/:id'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<'/orgs/:org/repos/:repo'>>().toEqualTypeOf<'org' | 'repo'>()
    expectTypeOf<keyof PathParams<'/health'>>().toEqualTypeOf<never>()
    expectTypeOf<keyof PathParams<'/orgs/:id/members/:id'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<'/users/:id.json'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<'/a/:id-b'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<'/users/:id_v2'>>().toEqualTypeOf<'id_v2'>()
    expectTypeOf<keyof PathParams<'/a/:one/b/:two/c/:three'>>().toEqualTypeOf<'one' | 'two' | 'three'>()
    // A '?' ends a token name too — the spec flagged this as assumed rather
    // than tested. Note buildUrl produces a second '?' if the call also has
    // query params (BACKLOG §2.3); that is pre-existing and not this feature's.
    expectTypeOf<keyof PathParams<'/search/:q?x=1'>>().toEqualTypeOf<'q'>()
  })
})
