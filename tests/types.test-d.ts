import { describe, it, expectTypeOf } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import type { MiddlewareContext, CallOptions, RequestConfig } from '../src/types.js'
import type { ApiErrorKind } from '../src/types.js'
import { successResult, errorResult } from '../src/testing.js'
import type { ApiError } from '../src/types.js'
import type { StandardSchemaV1 } from '../src/types.js'
import type { PathParams } from '../src/define-request.js'
import { defineRequest } from '../src/define-request.js'

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
    //
    // As of 4.1.0 `defineRequest` DOES catch this — see "defineRequest — the
    // responseType: none guard" below. This test is the `new Request` half of
    // that comparison: the class still cannot, for the reason above, and that
    // is why the factory exists. Still do NOT add a `@ts-expect-error` here.
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
    // A token must BEGIN a path segment, matching buildUrl's Phase 1b. A colon
    // inside a segment — a Google-style custom method, or a time — is not a token.
    expectTypeOf<keyof PathParams<'/v1/documents:batchGet'>>().toEqualTypeOf<never>()
    expectTypeOf<keyof PathParams<'/events/at/12:30'>>().toEqualTypeOf<never>()
    expectTypeOf<keyof PathParams<'/v1/docs:run/:id'>>().toEqualTypeOf<'id'>()
    // ...but a token at character zero IS one: buildUrl's anchor is the start of
    // each split('/') segment, and segment 0 begins at index 0 whether or not the
    // path has a leading slash.
    expectTypeOf<keyof PathParams<':id'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<':id/foo'>>().toEqualTypeOf<'id'>()
    expectTypeOf<keyof PathParams<'users/:id'>>().toEqualTypeOf<'id'>()
  })
})

describe('defineRequest — inference through createApi', () => {
  interface Repo { id: string }

  const inferApi = createApi({
    baseUrl: '/api',
    requests: {
      getUser: defineRequest<User>()({ method: 'GET', path: '/users/:id' }),
      listRepos: defineRequest<Repo[], { page?: number }>()({ method: 'GET', path: '/orgs/:org/repos' }),
      health: defineRequest<{ ok: boolean }>()({ method: 'GET', path: '/health' }),
      legacy: new Request<{ id: string }, User>({ method: 'GET', path: '/legacy/:id' }),
    },
  })

  it('infers path params and keeps the response type', async () => {
    const r = await inferApi.getUser({ id: '42' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })

  it('accepts a numeric path param', () => {
    expectTypeOf(inferApi.getUser).toBeCallableWith({ id: 42 })
  })

  it('merges extra params and keeps them optional', () => {
    expectTypeOf(inferApi.listRepos).toBeCallableWith({ org: 'acme' })
    expectTypeOf(inferApi.listRepos).toBeCallableWith({ org: 'acme', page: 2 })
  })

  it('leaves params optional for a path with no tokens', () => {
    expectTypeOf(inferApi.health).toBeCallableWith()
  })

  it('coexists with new Request in one client', async () => {
    const r = await inferApi.legacy({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })

  it('rejects the wrong param name, an object value, a missing path param, and a typo', () => {
    // @ts-expect-error  the path says :id, not :userId — the whole point
    void inferApi.getUser({ userId: '42' })
    // @ts-expect-error  a path param cannot be an object
    void inferApi.getUser({ id: { a: 1 } })
    // @ts-expect-error  org comes from the path and is required
    void inferApi.listRepos({ page: 2 })
    // @ts-expect-error  typo in an extra param
    void inferApi.listRepos({ org: 'acme', pge: 2 })
  })
})

describe('defineRequest — the responseType: none guard', () => {
  it("accepts 'none' when TResponse is undefined", async () => {
    // `toMatchTypeOf<Request<object, undefined>>()` is structural and this
    // shape is nearly vacuous — it would pass for almost any Request. Route
    // it through createApi instead and pin the thing that actually matters:
    // `data` is `undefined` on the success branch, in the style of the
    // `responseType: 'none'` describe block above.
    const pingApi = createApi({
      baseUrl: '/api',
      requests: {
        ping: defineRequest<undefined>()({ method: 'POST', path: '/ping', responseType: 'none' }),
      },
    })
    const r = await pingApi.ping()
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<undefined>()
  })

  it("rejects 'none' paired with a declared response body", () => {
    // This is what 3.1.0 tried and dropped. An overload pair could not do it:
    // TS falls through to the general signature for any call the narrow one
    // refuses, so the guard reported nothing. A single signature has nothing
    // to fall through to.
    // @ts-expect-error  declaring User while saying the body is empty
    defineRequest<User>()({ method: 'DELETE', path: '/u/:id', responseType: 'none' })
  })

  it('still accepts a RequestConfig-typed variable and a spread of one, and keeps TResponse', async () => {
    // The naive guard — constraining the config whenever TResponse is not
    // undefined — rejects BOTH of these, and both must keep compiling. They
    // are the forms src/types.ts's ResponseType JSDoc names as the reason the
    // original guard had to stay permissive.
    //
    // Compiling is not enough. The schema-conflict guard's first cut asked
    // "was a schema given?" one way for the guard and a different way for the
    // return type, so both of these compiled while silently discarding the
    // explicit TResponse — `data` came back `unknown`, not `User`, with no
    // error anywhere. Route through createApi and assert on `data` so a
    // regression like that fails loudly instead of merely failing to compile.
    const loose: RequestConfig = { method: 'GET', path: '/x' }
    const wideApi = createApi({
      baseUrl: '/api',
      requests: {
        bare: defineRequest<User>()(loose),
        spread: defineRequest<User>()({ ...loose, path: '/users/:id' }),
      },
    })

    const bareResult = await wideApi.bare()
    if (bareResult.error) return
    expectTypeOf(bareResult.data).toEqualTypeOf<User>()

    const spreadResult = await wideApi.spread({ id: '1' })
    if (spreadResult.error) return
    expectTypeOf(spreadResult.data).toEqualTypeOf<User>()
  })

  it("accepts an ordinary responseType alongside a real response type", () => {
    defineRequest<User>()({ method: 'GET', path: '/u/:id', responseType: 'json' })
  })
})

describe('defineRequest — schema-inferred response types', () => {
  const evenSchema: StandardSchemaV1<number> = {
    '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v as number }) },
  }
  const userSchema: StandardSchemaV1<User> = {
    '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v as User }) },
  }

  const schemaApi = createApi({
    baseUrl: '/api',
    requests: {
      fromSchema: defineRequest()({ method: 'GET', path: '/users/:id', schema: userSchema }),
      explicit:   defineRequest<User>()({ method: 'GET', path: '/users/:id' }),
      neither:    defineRequest()({ method: 'GET', path: '/x' }),
    },
  })

  it('takes the response type from the schema', async () => {
    const r = await schemaApi.fromSchema({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })

  it('still infers path params alongside a schema', () => {
    expectTypeOf(schemaApi.fromSchema).toBeCallableWith({ id: '42' })
    // @ts-expect-error  the path says :id
    void schemaApi.fromSchema({ userId: '42' })
  })

  it('honours an explicit response type when there is no schema', async () => {
    const r = await schemaApi.explicit({ id: '1' })
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<User>()
  })

  it('is unknown when neither is given, exactly as 4.1.1 behaved', async () => {
    const r = await schemaApi.neither()
    if (r.error) return
    expectTypeOf(r.data).toEqualTypeOf<unknown>()
  })

  it('refuses a schema alongside an explicit response type, even when they agree', () => {
    // Two sources of truth that can drift apart. The failure this prevents is
    // temporal: the schema changes, the explicit type is now wrong, and nothing
    // says so because it was never being read.
    // @ts-expect-error  they disagree
    defineRequest<User>()({ method: 'GET', path: '/u', schema: evenSchema })
    // @ts-expect-error  ...and they agree
    defineRequest<User>()({ method: 'GET', path: '/u', schema: userSchema })
  })

  it('leaves the empty-body guard and widened configs alone', async () => {
    defineRequest<undefined>()({ method: 'POST', path: '/p', responseType: 'none' })

    // Compiling alone doesn't prove TResponse survived — see the identical
    // regression note on "still accepts a RequestConfig-typed variable and a
    // spread of one" in the responseType: 'none' guard block above. Assert on
    // `data` here too.
    const loose: RequestConfig = { method: 'GET', path: '/x' }
    const wideApi = createApi({
      baseUrl: '/api',
      requests: {
        bare: defineRequest<User>()(loose),
        spread: defineRequest<User>()({ ...loose, path: '/users/:id' }),
      },
    })

    const bareResult = await wideApi.bare()
    if (bareResult.error) return
    expectTypeOf(bareResult.data).toEqualTypeOf<User>()

    const spreadResult = await wideApi.spread({ id: '1' })
    if (spreadResult.error) return
    expectTypeOf(spreadResult.data).toEqualTypeOf<User>()

    // @ts-expect-error  the empty-body guard still fires
    defineRequest<User>()({ method: 'DELETE', path: '/u', responseType: 'none' })
  })
})
