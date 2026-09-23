# apify

Runtime-agnostic, type-safe HTTP client for REST and GraphQL. Built on standard `fetch`. Zero dependencies.

- **Unified API** — REST and GraphQL share the same `Result<T>` shape, middleware stack, and error contract
- **Never throws** — every call returns `{ data, error, response, retry }`, no try/catch required
- **Composable middleware** — retry, cache, dedupe, auth, logging — applied at global, per-endpoint, or per-call level
- **Types by inference** — declare params and response once on the endpoint definition; types flow to every call site automatically
- **Runtime-agnostic** — Node.js 20+, browsers, Bun, Deno, Cloudflare Workers, React Native — any environment with `fetch`
- **Tiny** — about **2.9 kB gzipped** for a REST-only import, 4.4 kB for everything including GraphQL and all middleware; tree-shaking drops what you do not import

```
npm install @iremlopsum/apify
```

## Table of Contents

- [Getting Started](#getting-started)
- [REST API](#rest-api)
  - [Request](#request)
  - [`defineRequest`](#definerequest)
  - [Response validation](#response-validation)
  - [Pagination](#pagination)
  - [Query strings](#query-strings)
  - [Result](#result)
  - [Error handling with `onError`](#error-handling-with-onerror)
  - [Middleware](#middleware)
    - [Built-in middleware (retry, cache, log)](#built-in-middleware)
  - [Content types](#content-types)
  - [Response parsing](#response-parsing)
  - [Cancellation](#cancellation)
  - [Timeout](#timeout)
  - [Sharing](#sharing)
  - [TypeScript](#typescript)
- [GraphQL Client](#graphql-client)
  - [Queries and mutations](#queries-and-mutations)
  - [GraphQL errors](#graphql-errors)
  - [Middleware](#middleware-1)
- [Testing](#testing)
- [Philosophy](#philosophy)
- [API Reference](#api-reference)

## Getting Started

Define your endpoints as `Request` instances, wire them into a client with `createApi`, and call them with full type safety.

```ts
import { createApi, Request } from '@iremlopsum/apify'

// 1. Define your endpoints
interface User {
  id: string
  name: string
  email: string
}

const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id'
})

const createUser = new Request<{ name: string; email: string }, User>({
  method: 'POST',
  path: '/users'
})

// 2. Create the client
const api = createApi({
  baseUrl: 'https://api.example.com',
  requests: { getUser, createUser },
  onError: (error) => console.error(`${error.request.method} ${error.request.url}`, error.status)
})

// 3. Make a call — params and response are fully typed
const { data, error, retry } = await api.getUser({ id: '42' })

if (error) {
  console.error(error.status, error.body)
  return
}

// data is typed as User
console.log(data.name)
```

## REST API

### Request

Each API endpoint is represented by a `Request` instance. The class is a typed config container -- it stores the recipe for how an endpoint should be called, but does not execute anything on its own.

```ts
import { Request } from '@iremlopsum/apify'

const listItems = new Request<{ page: number; limit: number }, Item[]>({
  method: 'GET',
  path: '/items'
})
```

The two type parameters drive the entire type system:

- `TParams` -- the shape of the params object the caller must provide (path params, query params, and body params combined).
- `TResponse` -- the shape of the successful response data. This becomes the type of `result.data`.

When an endpoint takes no params, use `Record<string, never>` and the generated method will accept an optional (or omitted) params argument:

```ts
const health = new Request<Record<string, never>, { status: string }>({
  method: 'GET',
  path: '/health'
})

// Both work:
await api.health()
await api.health({})
```

#### Path parameters

Use `:param` syntax in the path. Matching keys from the params object are substituted into the URL and excluded from the query string or body:

```ts
const getItem = new Request<{ orgId: string; id: string }, Item>({
  method: 'GET',
  path: '/orgs/:orgId/items/:id'
})

// Calls GET /orgs/acme/items/42
await api.getItem({ orgId: 'acme', id: '42' })
```

#### `responseType`

Controls how the response body is parsed. Defaults to `'json'`.

```ts
const downloadFile = new Request<{ id: string }, Blob>({
  method: 'GET',
  path: '/files/:id',
  responseType: 'blob'
})
```

See [Response parsing](#response-parsing) for all options.

#### `dedupe`

When `true`, firing a new call to this endpoint auto-cancels any previous in-flight call. Useful for search-as-you-type or rapidly changing filters:

```ts
const searchUsers = new Request<{ q: string }, User[]>({
  method: 'GET',
  path: '/users/search',
  dedupe: true
})

// If a second call starts before the first finishes, the first is aborted
await api.searchUsers({ q: 'hel' })
await api.searchUsers({ q: 'hello' }) // previous call is auto-cancelled
```

#### `share`

When `true`, identical concurrent calls to this endpoint join a single in-flight request instead of firing their own. See [Sharing](#sharing) for the full contract — including its mutual exclusion with `dedupe` and what disables it.

```ts
const getProduct = new Request<{ id: string }, Product>({
  method: 'GET',
  path: '/products/:id',
  share: true
})

// Both calls join the same network request
await Promise.all([
  api.getProduct({ id: '42' }),
  api.getProduct({ id: '42' })
])
```

#### `bodyAs`

Overrides the default body serialization strategy. By default, GET/DELETE serialize params as query strings and POST/PUT/PATCH serialize params as a JSON body. Use `bodyAs` to invert that:

```ts
// DELETE endpoint that expects a JSON body
const bulkDelete = new Request<{ ids: string[] }, { deleted: number }>({
  method: 'DELETE',
  path: '/items',
  bodyAs: 'body'
})

// POST endpoint that sends params as query string
const triggerJob = new Request<{ priority: number }, Job>({
  method: 'POST',
  path: '/jobs/trigger',
  bodyAs: 'query'
})
```

### `defineRequest`

`new Request<TParams, TResponse>` makes you restate what the path already says,
and nothing checks the two against each other:

```ts
// The params are restated by hand, and nothing checks them against the path:
const getUser = new Request<{ userId: string }, User>({ method: 'GET', path: '/users/:id' })

api.getUser({ userId: '42' })  // compiles — then fails at runtime: buildUrl finds
                               // no `:userId` to substitute, `:id` survives, and
                               // the unresolved-token check throws
```

`defineRequest` infers the params from the path literal instead:

```ts
import { defineRequest } from '@iremlopsum/apify'

const getUser = defineRequest<User>()({ method: 'GET', path: '/users/:id' })

api.getUser({ id: '42' })      // ✓
api.getUser({ id: 42 })        // ✓ — numbers are encoded
api.getUser({ userId: '42' })  // ✗ Object literal may only specify known properties
```

Params the path does not name — query or body fields — go in the second type
argument:

```ts
const listRepos = defineRequest<Repo[], { page?: number }>()({
  method: 'GET',
  path: '/orgs/:org/repos',
})

api.listRepos({ org: 'acme' })            // ✓ page is optional
api.listRepos({ org: 'acme', page: 2 })   // ✓
api.listRepos({ page: 2 })                // ✗ org is required
```

It also enforces the `responseType: 'none'` convention that `new Request` can
only document:

```ts
defineRequest<undefined>()({ method: 'POST', path: '/ping', responseType: 'none' })  // ✓
defineRequest<User>()({ method: 'POST', path: '/ping', responseType: 'none' })       // ✗
```

**Why two calls.** TypeScript has no partial type-argument inference: if the response
type and the config were arguments to one call, supplying the response type explicitly
would stop the path from being inferred, and the checking would quietly do nothing.
Splitting them keeps the response type explicit and the path inferred. Calling it
wrong is a compile error, not a silent one.

`new Request(...)` is unchanged and not deprecated — use it when the config is
not a literal, or when you do not want the path checked.

### Response validation

Pass any [Standard Schema](https://standardschema.dev) validator — Zod, Valibot,
ArkType — and the response is checked before you see it. apify takes no
dependency on one; Standard Schema is an interface, not a package.

```ts
import { z } from 'zod'

const getUser = defineRequest()({
  method: 'GET',
  path: '/users/:id',
  schema: z.object({ id: z.string(), name: z.string() }),
})

const { data, error } = await api.getUser({ id: '42' })
//      ^? { id: string; name: string } | null
```

The schema supplies the response type, so there is no type argument to write —
and no second place for it to drift out of date.

**`data` is the schema's output.** A schema that transforms changes what you
receive:

```ts
const getUser = defineRequest()({
  method: 'GET',
  path: '/users/:id',
  schema: z.object({
    id: z.string(),
    createdAt: z.coerce.date(),        // the wire sends a string
    role: z.string().default('user'),  // absent on the wire
  }),
})

const { data } = await api.getUser({ id: '42' })
data.createdAt   // a real Date
data.role        // 'user' when the server omitted it
```

That is the point of validating through a schema rather than merely checking
one — but it does mean `data` is no longer byte-identical to the response.

A response the schema refuses is an error `Result`, never a throw:

```ts
const { error } = await api.getUser({ id: '42' })
if (error?.kind === 'parse') {
  console.error(error.body)  // the validator's issues
  error.status               // the response's own status — the server was fine
}
```

Only the **success** body is validated. A non-2xx body is diagnostic and often a
different shape, so it is left alone.

Schemas work on the GraphQL client too, validating the response's `data`:

```ts
const me = new Operation<{}, User>({
  operation: gql`query { me { id name } }`,
  schema: UserSchema,
})
```

There the response type stays explicit — only `defineRequest` infers it.

### Pagination

`paginate` walks a paginated endpoint, yielding one `Result` per page:

```ts
import { paginate } from '@iremlopsum/apify'

for await (const page of paginate(api.listItems, { limit: 50 }, {
  next: (p, prev) => p.data.cursor ? { ...prev, cursor: p.data.cursor } : undefined,
})) {
  if (page.error) break
  render(page.data.items)
}
```

**`next` returns the next params, not a cursor.** That is what keeps this
library out of the business of guessing where a cursor goes — `cursor`?
`page_token`? `after`? The previous params arrive as the second argument, so
the common case is a spread, and the same shape covers every scheme:

```ts
// offset
next: (p, prev) => p.data.items.length === prev.limit
  ? { ...prev, offset: prev.offset + prev.limit }
  : undefined

// page number, driven by a Link header
next: (p, prev) => p.response.headers.get('link')?.includes('rel="next"')
  ? { ...prev, page: prev.page + 1 }
  : undefined
```

Return `undefined` or `null` to stop.

**An error page is yielded, then the walk ends.** There is no data to read the
next cursor from, so there is nothing to continue with — and you see what
failed rather than a loop that quietly stopped.

**`maxPages` is optional and has no default.** A ceiling exists if you want one;
the library will not invent a number, because a silent truncation at an
arbitrary limit looks exactly like reaching the last page.

```ts
paginate(api.listItems, { limit: 50 }, { next, maxPages: 100 })
```

Any other [`CallOptions`](#calloptions) — `signal`, `timeout`, `headers` — apply
to every request, so one signal cancels the whole crawl.

`paginate` yields pages, not items. Flattening would mean deciding which field
holds the array, which is the convention-guessing `next` exists to avoid.

### Query strings

For GET and DELETE requests (or any request with `bodyAs: 'query'`), params that are not consumed by path substitution are serialized as a query string using `URLSearchParams`.

A `baseUrl` may carry its own query string — a fixed API key, say. Its params
are merged ahead of the call's:

```ts
const api = createApi({
  baseUrl: 'https://api.example.com/v1?key=abc',
  requests: { search: new Request<{ q: string }, Hit[]>({ method: 'GET', path: '/search' }) },
})

await api.search({ q: 'hello' })
// GET https://api.example.com/v1/search?key=abc&q=hello
```

Merging **accumulates**, it does not override: a call param whose key the base
already used produces both, `?key=abc&key=xyz`, and which one wins is the
server's decision. This differs from headers, where a per-call value replaces a
global one — because array params already serialize as repeated keys
(`tags=a&tags=b`), so collapsing duplicates would break them. If a base-level
param needs to vary per call, set it from middleware rather than the `baseUrl`.

**A `#fragment` is refused.** A fragment is never sent to the server, so one in
a `path` or `baseUrl` cannot do what it appears to — and before 4.2.1 it
silently discarded the query string. It is now an error naming the offending
value, rather than being stripped, so the dead code does not stay in your
template.

Since 4.4.0 a fragment in a [`defineRequest`](#definerequest) `path` **literal**
is also a compile error, so the endpoint is rejected where it is declared rather
than on every call:

```ts
defineRequest<Doc>()({ method: 'GET', path: '/docs#section' })
//                                          ^ Property '__fragmentInPath' is missing:
//                                            a URL fragment is never sent to the server
```

The check reads the literal, so a path assembled at runtime — or a
`RequestConfig`-typed variable — still compiles and is caught by the runtime
error instead. `new Request` takes no path literal, so it has no equivalent
check; this is one of the things `defineRequest` buys you.

**A `#` inside a param *value* is not a fragment** and is never refused — it is
escaped to `%23` and sent as ordinary data:

```ts
await api.getDoc({ id: 'a#b' })   // → GET /docs/a%23b
await api.search({ tag: 'a#b' })  // → GET /search?tag=a%23b
```

Only a `#` written into a `path` or `baseUrl` is refused, because that one was
never going to reach the server.

| Input                          | Output                      |
| ------------------------------ | --------------------------- |
| `{ page: 1, limit: 20 }`      | `?page=1&limit=20`          |
| `{ tags: ['a', 'b'] }`        | `?tags=a&tags=b`            |
| `{ filter: null }`            | _(omitted)_                 |
| `{ filter: undefined }`       | _(omitted)_                 |
| `{ meta: { nested: true } }`  | **TypeError** (see below)   |

**Arrays** use repeated keys (`tags=a&tags=b`), which is the most widely supported format across server frameworks.

**`null` and `undefined`** values are silently omitted from the query string.

**Nested objects** throw a `TypeError` with a descriptive message. Flatten the structure before passing. This is intentional -- there is no universal standard for serializing nested objects in query strings (brackets, dots, JSON), so the library refuses to guess.

### Result

Every API call returns a `Result<TResponse>` instead of throwing. It's a discriminated union on `error`, not a plain interface:

```ts
interface SuccessResult<TResponse> {
  data: TResponse                          // parsed response
  error: null
  response: Response                       // always present on success
  retry: () => Promise<Result<TResponse>>
}

interface ErrorResult<TResponse> {
  data: null
  error: ApiError                          // structured error, see below
  response: Response | null                // present for HTTP/parse failures, null for network/abort/timeout
  retry: () => Promise<Result<TResponse>>
}

type Result<TResponse> = SuccessResult<TResponse> | ErrorResult<TResponse>
```

Check `error` first, then use `data` with confidence: `if (error) return` (or any other narrowing check on `error`) narrows `data` to `TResponse` for the rest of the function -- no `data!` assertion needed. That narrowing is only as accurate as `TResponse` itself, though: an endpoint that answers `204` or an empty `200` (a `DELETE`, most commonly) doesn't return a body at all -- declare it with `responseType: 'none'` and `TResponse` of `undefined`, rather than widening `TResponse` to `| null`, which since 4.0.0 does not work
at all -- an empty body under `'json'` is a `'parse'` error -- see [Response parsing](#response-parsing) below. Branch on `error.kind` rather than `error.status` — `'network'`, `'abort'` and `'timeout'` all carry `status: 0`, but they call for different handling:

```ts
const { data, error, response, retry } = await api.getUser({ id: '42' })

if (error) {
  switch (error.kind) {
    case 'network':
      // fetch itself failed -- user is probably offline
      break
    case 'timeout':
      // the whole-operation deadline fired; report it
      reportTimeout(error)
      break
    case 'abort':
      // this call was cancelled (dedupe supersede, or your own signal) -- usually ignore it
      break
    case 'parse':
      // a 2xx response arrived but its body didn't parse as `responseType`
      console.error('unparseable response', error.status, error.body)
      break
    case 'middleware':
      // a middleware threw -- a bug in your own pipeline, not a transient failure
      console.error('middleware threw', error.body)
      break
    case 'http':
      if (error.status === 401) redirectToLogin()
      else console.error(error.status, error.body)
      break
  }
  return
}

// error is null here, so `data` is narrowed to `User` -- no assertion needed
// (this assumes getUser always answers with a body; an endpoint that
// doesn't -- a DELETE returning 204, most commonly -- should use
// responseType: 'none' instead, see the empty-body note above)
console.log(data.name)
```

`response`'s body has already been consumed by the time you see it -- the library reads it to produce `data` (or `error.body`), so calling `response.json()` yourself throws "Body has already been read". Use `data`/`error.body`; `response` is for status, headers, and redirect metadata. (This applies only to results the library produces itself -- a `Response` you construct for `successResult()` in `testing.ts` still has a readable body.)

#### `retry()`

The `retry` function re-executes the exact same request through the full middleware chain. Auth tokens are re-injected, logging fires again, everything runs fresh. This is useful for retry-after-refresh patterns:

```ts
const { data, error, retry } = await api.getUser({ id: '42' })

if (error?.status === 401) {
  await refreshToken()
  const retried = await retry()
  // retried goes through the full middleware chain again
}
```

#### `ApiError`

The error object on failed calls. It is not a subclass of `Error` -- it is a structured container for API-level error details.

| Property     | Type      | Description                                                       |
| ------------ | --------- | ----------------------------------------------------------------- |
| `status`     | `number`  | HTTP status code (e.g., 404, 500). `0` for network errors, aborts, and timeouts. |
| `kind`       | `'http' \| 'network' \| 'abort' \| 'timeout' \| 'parse' \| 'middleware'` | What category of failure this is. See below. Required -- constructing an `ApiError` yourself (e.g. in custom middleware) must supply it. |
| `statusText` | `string`  | HTTP status text (e.g., 'Not Found'). `''` for network errors.    |
| `body`       | `unknown` | Parsed response body -- but for `'parse'`, one of: the thrown exception (a malformed body), the raw response text (an empty body, or a GraphQL response carrying no data), a schema's issues array (the response failed validation), or a value a schema threw. The native Error for network failures. |
| `headers`    | `Headers` | Response headers. Empty `Headers` for network errors.             |
| `request`    | `object`  | `{ method, url, params }` -- metadata about the failed request; `url` is the resolved, path-substituted address, falling back to the route template only when it could not be built. |
| `partialData` | `unknown` (optional) | GraphQL data returned alongside `{ errors }` (partial success). Lives here, not on `Result.data`, so the `Result` stays a clean union: `data` is non-null iff `error` is null. `undefined` for every REST error and for GraphQL responses carrying no data. |

`kind` exists because `status` alone cannot tell some outcomes apart: an HTTP error (`'http'`), a `fetch` failure with no response (`'network'`), a cancellation — your own signal, a dedupe supersede, or a whole-operation deadline firing — (`'abort'`/`'timeout'`), a 2xx (or non-2xx) body that failed to parse (`'parse'`), and a middleware that threw instead of the request itself failing (`'middleware'`) all need different handling, but `'network'`, `'abort'`, and `'timeout'` all carry `status: 0`.

`'parse'` is for a **2xx** response that arrived but whose body failed to parse according to `responseType` -- you get the real `status`, a non-null `response`, and `kind: 'parse'`. A **non-2xx** response with an unparseable body is unaffected and still reports `kind: 'http'` -- the status code is checked before the body is parsed, so a 500 with a broken JSON body is still a 500, and `retryMiddleware`'s default 5xx retry still applies to it. An **empty** body under `'json'` is also `'parse'` -- see [Response
parsing](#response-parsing). GraphQL applies the same rule to a 2xx response
carrying neither `data` nor `errors`. An optional [`schema`](#response-validation) on the request adds two more `'parse'` producers: a **2xx** body the schema refuses (`error.body` is its issues array) and a validator that throws (`error.body` is the thrown value) -- both only for the success body, never for a non-2xx one, which is never validated.

`'middleware'` means a middleware threw rather than the request itself failing -- a bug in your own pipeline you'd fix, not a transient failure you'd retry. A middleware that propagates the library's own abort/timeout signal (verbatim, or wrapped one level as `.cause`) is classified `'abort'`/`'timeout'` instead, by provenance rather than by the reason's name -- see [Cancellation](#cancellation).

You can use `instanceof` to check if a value is an `ApiError`:

```ts
import { ApiError } from '@iremlopsum/apify'

if (error instanceof ApiError) {
  // ...
}
```

### Error handling with `onError`

The `onError` callback in `createApi` fires after the full middleware chain completes whenever the final result has an error. If a retry middleware recovers a 5xx to a 200, `onError` does not fire.

```ts
const api = createApi({
  baseUrl: '/api',
  requests: { getUser, createUser },
  onError: (error) => {
    if (error.status === 401) redirectToLogin()
    Sentry.captureException(error)
  }
})
```

This fires for `kind: 'http'`, `'network'`, `'timeout'`, `'parse'`, and `'middleware'`. **It does not fire for `kind: 'abort'`** — a cancellation the library caused deliberately (your own `AbortSignal` firing, or a request superseded by `dedupe`) is not a failure worth reporting to an error tracker, unlike a `'timeout'`, which is a deadline you actually missed. The caller still gets the abort back in the `Result` either way; only the report to this callback is suppressed. It is a global hook for side effects (logging, telemetry, redirects) -- it does not change the result returned to the caller.

### Middleware

Middleware follows the onion model (like Koa or Redux middleware). Each middleware wraps the next layer, can modify the request going in and the result coming out.

```
Request → [Global MW → [Per-request MW → [Per-call MW → [fetch]]]]
```

A middleware function receives a `context` and a `next` function:

```ts
import type { Middleware } from '@iremlopsum/apify'

const authMiddleware: Middleware = async (ctx, next) => {
  // Before: modify the request
  ctx.request.headers.set('Authorization', `Bearer ${getToken()}`)

  // Call the next layer
  const result = await next()

  // After: inspect or transform the result
  return result
}
```

#### What middleware can do

- **Modify the request** -- set headers, change the body, rewrite the URL.
- **Short-circuit** -- return early without calling `next()` (e.g., serve from cache).
- **Retry** -- call `next()` multiple times in a loop (e.g., retry on 5xx).
- **Inspect the result** -- log, report errors, transform response data.

#### Three layers

Middleware is applied at three levels. The execution order is global first, per-request second, per-call third:

```ts
// Global -- applies to every endpoint
const api = createApi({
  baseUrl: '/api',
  requests: { getUser, createUser },
  middleware: [authMiddleware, logMiddleware]
})

// Per-request -- applies only to this endpoint
const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id',
  middleware: [cacheMiddleware]
})

// Per-call -- applies only to this single invocation
await api.getUser({ id: '42' }, {
  middleware: [customTraceMiddleware]
})
```

#### `skipMiddleware`

Remove specific middleware for a single call by passing references to `skipMiddleware`:

```ts
const retry = retryMiddleware(3)

const api = createApi({
  baseUrl: '/api',
  requests: { getUser },
  middleware: [retry, logMiddleware]
})

// Skip retry for this one call
await api.getUser({ id: '42' }, {
  skipMiddleware: [retry]
})
```

Comparison is by reference (`===`). Factory-style middleware like `retryMiddleware(3)` must be stored in a variable first -- calling the factory again creates a new reference that will not match.

#### `MiddlewareContext`

The context object passed to each middleware:

| Property              | Type      | Description                                              |
| --------------------- | --------- | -------------------------------------------------------- |
| `request.method`      | `string`  | HTTP method (GET, POST, etc.)                            |
| `request.url`         | `string`  | Fully resolved URL with path params and query string     |
| `request.path`        | `string`  | Original path template (e.g., '/users/:id')              |
| `request.params`      | `unknown` | Original params object from the caller                   |
| `request.headers`     | `Headers` | Merged headers -- middleware can add/remove entries       |
| `request.body`        | `unknown` | Serialized body, or null for GET/DELETE                  |
| `request.signal`      | `AbortSignal \| undefined` | The signal handed to `fetch` -- replace it to impose your own cancellation policy |
| `requestName`         | `string`  | Key name in the requests object (e.g., 'getUser')        |

`request.signal` holds the call's own signal: the caller's `options.signal` merged with any `timeout` (and, under `share: true`, with the refcount that aborts the shared request once every sharer has given up). It is `undefined` only when there is none of those. The core fetch reads the field at call time, so replacing it takes effect -- that is all a timeout middleware needs:

```ts
const timeout = (ms: number): Middleware => async (ctx, next) => {
  ctx.request.signal = AbortSignal.timeout(ms)
  return next()
}

const api = createApi({
  baseUrl: '/api',
  requests: { getUser },
  middleware: [timeout(5000)]
})
```

Under `dedupe: true` your signal is merged rather than discarded: the request is cancelled by whichever fires first -- your signal, or a newer call superseding this one. The dedupe signal is installed by the core fetch, so middleware reading `ctx.request.signal` before `next()` sees the caller's signal, not the dedupe one.

**Pass `ctx.request.signal` on to any async work your middleware does itself** -- a token refresh, a lookup, a queue. The library will not wait for that work past the call's deadline or the caller's abort either way (see [Timeout](#timeout)), but a promise cannot be cancelled from outside: handing it the signal is the only thing that actually *stops* the work, instead of leaving it running in the background with its result discarded.

#### Writing custom middleware

A cache middleware that short-circuits on cache hits:

```ts
const cacheMiddleware: Middleware = async (ctx, next) => {
  const cached = cache.get(ctx.request.url)
  if (cached) return cached

  const result = await next()

  if (result.data) {
    cache.set(ctx.request.url, result)
  }

  return result
}
```

An error reporting middleware:

```ts
const sentryMiddleware: Middleware = async (ctx, next) => {
  const result = await next()

  if (result.error && result.error.status >= 500) {
    Sentry.captureMessage(`API error: ${ctx.request.method} ${ctx.request.url}`, {
      extra: { status: result.error.status, body: result.error.body }
    })
  }

  return result
}
```

#### Built-in middleware

The library ships three optional middleware functions, importable from a separate entry point:

```ts
import { retryMiddleware, logMiddleware, cacheMiddleware } from '@iremlopsum/apify/middleware'
```

**`retryMiddleware(options?: number | RetryOptions)`**

Automatically retries requests that fail, with a real backoff policy — exponential (or linear, or custom) delay curves, full jitter, `Retry-After` support, a configurable retry predicate, and an observational `onRetry` hook.

The numeric shorthand still works exactly as before — `retryMiddleware(2)` retries up to 2 additional times (3 total attempts) on a 5xx response:

```ts
const api = createApi({
  baseUrl: '/api',
  requests: { getItems },
  middleware: [retryMiddleware(2)]
})
```

By default, only server errors (`status >= 500`) are retried. Client errors (4xx), 429, and network errors (`status: 0`) are not — see the opt-in recipes below.

**Retry policy**

Pass a `RetryOptions` object instead of a number for full control:

```ts
const api = createApi({
  baseUrl: '/api',
  requests: { getItems },
  middleware: [retryMiddleware({
    max: 5,
    delay: 'exponential',
    baseDelay: 250,
    maxDelay: 10_000,
    jitter: true,
    respectRetryAfter: true,
    onRetry: ({ attempt, max, delay }) => console.log(`retry ${attempt}/${max} in ${delay}ms`),
  })],
})
```

| Option              | Type                                              | Default          | Description |
| -------------------- | -------------------------------------------------- | ----------------- | ----------- |
| `max`                | `number`                                            | `3`               | Additional attempts after the first. `retryMiddleware({ max: 2 })` means up to 3 total calls. |
| `delay`              | `'exponential' \| 'linear' \| (attempt: number) => number` | `'exponential'`   | The delay curve. Exponential is `baseDelay * 2^(attempt-1)`; linear is `baseDelay * attempt`; a function receives the 1-based attempt number and returns milliseconds. |
| `baseDelay`          | `number`                                            | `250`             | The first delay, in milliseconds, before jitter and `Retry-After` are applied. |
| `maxDelay`           | `number`                                            | `30000`           | Hard cap applied to every computed delay, including a `Retry-After` value. |
| `jitter`             | `boolean`                                           | `true`            | Full jitter: the actual delay is `Math.random() * computed`, per AWS's recommendation for de-synchronizing a thundering herd. Never applied to a `Retry-After` value — a server telling you exactly when to come back should not be randomized. |
| `respectRetryAfter`  | `boolean`                                           | `true`            | Honor a `Retry-After` response header (delta-seconds or an HTTP-date) when present, replacing the computed delay outright (still capped by `maxDelay`). |
| `retryOn`            | `(result: Result<unknown>, attempt: number) => boolean` | `r => (r.error?.status ?? 0) >= 500` | Whether to retry. Called with the 1-based *candidate* attempt number, even once `max` is reached, so a predicate that counts attempts sees one call per result. |
| `onRetry`            | `(info: RetryInfo) => void`                         | —                 | Observational hook fired before each retry's delay elapses. Its return value is ignored, and a throw cannot fail the request — this is the only way to observe an in-progress retry sequence, since the call site sees nothing until the final result. |

`RetryInfo` (the argument to `onRetry`): `{ attempt, max, delay, result }` — `attempt` is 1-based (the first retry is `1`), `delay` is the actual delay about to elapse (after jitter and `Retry-After`), and `result` is the `Result` that triggered this retry.

**429 and network-error opt-in.** Both are deliberately excluded from the default `retryOn` — retrying a rate limit or a network failure by default would change behavior under existing callers on upgrade. Opt in explicitly:

```ts
// Retry 429 in addition to 5xx
retryMiddleware({
  retryOn: r => r.error?.status === 429 || (r.error?.status ?? 0) >= 500
})

// Retry network errors (status 0) too — but not aborts, which are also status 0
retryMiddleware({
  retryOn: r => (r.error?.status ?? 0) >= 500 || r.error?.kind === 'network'
})
```

**An abort during backoff surfaces as the abort, not the stale result it was retrying.** If the signal driving the request — a whole-operation `timeout`, a caller's own `AbortSignal`, or a dedupe supersede — fires while `retryMiddleware` is sleeping between attempts, the backoff sleep resolves immediately and the loop proceeds straight to the next attempt, which the core fetch rejects instantly (no network call) because the signal is already aborted. The caller receives **that abort** — `kind: 'timeout'` for a deadline, `kind: 'abort'` for a cancellation or a dedupe supersede — never the last real HTTP result (e.g. a stale `503`) that triggered the retry in the first place:

```ts
const api = createApi({
  baseUrl: '/api',
  requests: {
    getItems: new Request<Record<string, never>, Item[]>({
      method: 'GET',
      path: '/items',
      timeout: 2000, // whole-operation deadline
    })
  },
  middleware: [retryMiddleware({ max: 5, baseDelay: 1000 })], // long backoff
})

const { error } = await api.getItems()
// If the 2s deadline fires while retryMiddleware is asleep between attempts:
// error.status === 0, error.kind === 'timeout' -- not the 503 being retried
```

**`logMiddleware`**

Logs request start and completion to the console with timing:

```
[apify] → GET getItems /api/items
[apify] ← getItems OK (142ms)

[apify] → POST createUser /api/users
[apify] ← createUser ERROR 422 (89ms)
```

Intended for development. In production, write a custom middleware that sends telemetry to your observability platform.

```ts
const api = createApi({
  baseUrl: '/api',
  requests: { getItems },
  middleware: [logMiddleware]
})
```

**`cacheMiddleware(options?)`**

Caches successful responses in memory, keyed by request name and params. Calls with identical params within the TTL window are served from cache without hitting the network. Each `cacheMiddleware()` call creates an isolated store — different endpoints never share entries.

```ts
const getUserCache = cacheMiddleware({ ttl: 5 * 60_000, maxSize: 100 })

const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id',
  middleware: [getUserCache],
})

// On logout — clear all cached entries:
getUserCache.clear()

// Bypass cache for a single call:
const { data } = await api.getUser({ id: '42' }, { skipMiddleware: [getUserCache] })
```

Options: `ttl` (milliseconds, default 5 min), `maxSize` (max entries, default 50), `debug` (log hits/misses to console, default false). Only successful results are cached — errors always hit the network again.

### Content types

Request bodies are automatically serialized based on the input type. The `Content-Type` header is set for you unless you explicitly provide one.

| Input type        | Body output        | Content-Type                          |
| ----------------- | ------------------ | ------------------------------------- |
| `null`/`undefined` | `null`             | _(none)_                              |
| `string`          | as-is              | `text/plain`                          |
| `FormData`        | as-is              | _(browser sets multipart boundary)_   |
| `URLSearchParams` | as-is              | `application/x-www-form-urlencoded`   |
| `Blob`            | as-is              | `application/octet-stream`            |
| `ArrayBuffer`     | as-is              | `application/octet-stream`            |
| Plain object      | `JSON.stringify()` | `application/json`                    |

Header merge precedence (most specific wins):

1. **Global headers** (from `createApi` config) -- lowest priority
2. **Per-request headers** (from `Request` config) -- overrides global
3. **Per-call headers** (from `CallOptions`) -- highest priority

Explicitly set `Content-Type` headers at any level override the auto-detected value.

### Response parsing

The `responseType` option on a `Request` determines how the response body is parsed:

| `responseType`  | Method called          | Return type    |
| --------------- | ---------------------- | -------------- |
| `'json'`        | `response.text()` then `JSON.parse()` | parsed object  |
| `'text'`        | `response.text()`      | `string`       |
| `'blob'`        | `response.blob()`      | `Blob`         |
| `'arrayBuffer'` | `response.arrayBuffer()` | `ArrayBuffer` |
| `'formData'`    | `response.formData()`  | `FormData`     |
| `'none'`        | *(not read -- stream cancelled)* | `undefined` |

The default is `'json'`. An **empty body under `'json'` is an error**, not a
`null`: you declared JSON and the server sent none, so there is no value that
could honestly satisfy `TResponse`. You get `kind: 'parse'` with the
response's own status (a `204` reports `204`), a non-null `response`, and the
raw body text -- always `''` for this case -- in `error.body`:

```ts
const { data, error } = await api.deleteUser({ id: '42' })
// 204 No Content, responseType left at the 'json' default:
// error.kind === 'parse', error.status === 204, data === null
```

A literal `null` body is **not** empty -- `JSON.parse("null")` is valid JSON,
and that response still succeeds with `data: null`.

**`responseType: 'none'`** is the declaration for an endpoint that returns no
body on success -- a `204`, or a `200` with an empty body, most commonly a
`DELETE`:

```ts
const deleteUser = new Request<{ id: string }, undefined>({
  method: 'DELETE',
  path: '/users/:id',
  responseType: 'none',
})
```

No body is read on a successful (2xx) response: `data` is `undefined`, and any body the server sends anyway is discarded -- its stream is cancelled, so a keep-alive connection is released rather than held open by an unread body. Declare `TResponse` as `undefined` when using `responseType: 'none'` -- but this is a convention, not a compile-time guarantee: `new Request<{ id: string }, User>({ responseType: 'none' })` compiles clean, and if the two disagree, `data` is `undefined` at runtime behind whatever type you declared.

`'none'` only describes the **success** shape. A non-2xx response is still read and parsed as JSON for `error.body` -- an error body is diagnostic (a message, a code) and worth reading even when the caller wants nothing back on success:

```ts
const { error } = await api.deleteUser({ id: '42' })
if (error) {
  // A 409 { "error": "already deleted" } still lands in error.body here,
  // even though deleteUser declares responseType: 'none'.
  console.error(error.status, error.body)
}
```

(3.0.0's advice for this case was to widen the endpoint's `TResponse` to
`| null`. That advice is superseded: `responseType: 'none'` declares "no body"
rather than "body or null", and since 4.0.0 the `| null` workaround no longer
works at all -- the empty body is an error before `TResponse` is ever
consulted. See [MIGRATION.md](./MIGRATION.md#upgrading-to-400).)

### Cancellation

#### Manual abort via `AbortSignal`

Pass an `AbortSignal` through `CallOptions` to cancel a request:

```ts
const controller = new AbortController()

const promise = api.getItems({ page: 1 }, {
  signal: controller.signal
})

// Cancel the request
controller.abort()

const { error } = await promise
// error.status === 0, error.kind === 'abort', error.body is a DOMException with name 'AbortError'
```

A cancellation you caused yourself is not reported to `onError` (`kind: 'abort'` is the one kind that's suppressed there) -- see [Error handling with `onError`](#error-handling-with-onerror). It is classified by **provenance**, not by sniffing the thrown value's shape: whatever a middleware or `fetch` actually throws, if it happened because *this request's own signal* aborted, the `Result` is `kind: 'abort'` (or `'timeout'` for a deadline) regardless of the reason's name or type -- a caller-supplied custom abort reason (`controller.abort(new Error('unmounted'))`, or a plain string) still classifies as `'abort'`, not `'network'`.

Aborting settles the call even while a middleware is still awaiting work of its own that ignores the signal -- the same backstop that bounds `timeout`, described under [Timeout](#timeout).

#### Auto-cancel via `dedupe`

When a `Request` has `dedupe: true`, each new call automatically aborts the previous in-flight call for that endpoint. Identity is per `Request` instance -- different endpoints do not interfere with each other.

```ts
const searchUsers = new Request<{ q: string }, User[]>({
  method: 'GET',
  path: '/users/search',
  dedupe: true
})

const api = createApi({
  baseUrl: '/api',
  requests: { searchUsers }
})

// Rapid calls -- only the last one completes
api.searchUsers({ q: 'h' })    // aborted by next call
api.searchUsers({ q: 'he' })   // aborted by next call
api.searchUsers({ q: 'hel' })  // this one completes
```

Dedupe and manual abort signals work together. If both are active, the request is cancelled if either fires.

### Timeout

Set `timeout` (milliseconds) on a `Request` or per-call to abort a request that takes too long:

```ts
const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id',
  timeout: 5000
})

const { error } = await api.getUser({ id: '42' })
// error.status === 0, error.kind === 'timeout' if it fired
```

**`timeout` is a whole-operation deadline, not a per-attempt budget.** It covers the entire middleware chain, including every retry and every backoff delay. `timeout: 5000` combined with `retryMiddleware(3)` still means "an answer within 5 seconds" for the call as a whole — not five seconds for each individual attempt. This is a deliberate choice, and it **differs from axios, XHR, and `got`**, all of which apply a timeout per attempt and therefore let a retrying request run for a multiple of the configured timeout. Know which behavior you're assuming before you tune the number.

If you want a per-attempt budget instead — the axios-style behavior — write a small signal-replacing middleware and place it *inside* the retry middleware, so a fresh signal is installed on every attempt:

```ts
const perAttempt = (ms: number): Middleware => async (ctx, next) => {
  ctx.request.signal = AbortSignal.timeout(ms)
  return next()
}

const api = createApi({
  baseUrl: '/api',
  requests: { getUser },
  middleware: [retryMiddleware(3), perAttempt(5000)]
})
```

Because middleware order is outermost-to-innermost, `retryMiddleware(3)` re-invokes everything below it — including `perAttempt(5000)` — on every retry, so each attempt gets its own fresh 5-second budget instead of sharing one.

A few more details:

- `CallOptions.timeout` overrides `RequestConfig.timeout` for a single call; a per-call `timeout: 0` disables a per-request timeout rather than falling back to it.
- A timeout produces an error with `status: 0` and `kind: 'timeout'` — distinguishable from a caller-initiated cancellation (`kind: 'abort'`) and from a genuine network failure (`kind: 'network'`).
- `result.retry()` always starts a fresh deadline. A retried call is not charged against the original budget.
- Non-positive or omitted `timeout` disables it entirely (the default).
- `timeout` composes with `dedupe: true` — the deadline is merged with the dedupe signal rather than discarded by it.
- Under `share: true` the two timeouts have different owners. `RequestConfig.timeout` belongs to the *operation*: it bounds the one shared request for every caller, measured from when that request started, so a single caller can neither extend it nor disable it with a per-call `timeout: 0`. `CallOptions.timeout` bounds only the caller that passed it — see [Sharing](#sharing).

**The deadline bounds middleware that never looks at the signal, too.** A middleware that awaits something of its own before calling `next()` — a token refresh, say — cannot hold the call past its `timeout`, even if that work never settles:

```ts
const auth: Middleware = async (ctx, next) => {
  const token = await user.getIdToken()   // stalls on a bad network
  ctx.request.headers.set('Authorization', `Bearer ${token}`)
  return next()
}
// With timeout: 45_000, the call still settles at ~45s: kind 'timeout', status 0.
```

When the deadline passes, the chain gets one macrotask to answer by itself. That is enough for everything that already responds to the abort — `fetch` rejecting, a middleware rethrowing the reason, a fallback middleware that turns a timeout into a cached response — so all of those keep their own `Result` exactly as before. A chain still pending after that is waiting on something the signal does not reach, and the call settles with the same `Result` an aborted `fetch` would have produced: `kind: 'timeout'`, `status: 0`, reported to `onError` once. A caller's own `signal` works the same way, with `kind: 'abort'`, which is not reported.

A promise cannot be cancelled, so the stalled middleware keeps running. Whatever it eventually returns or throws is discarded — no second `Result`, no second `onError` — and if it calls `next()` after the call has settled, no request is sent: `next()` hands back the `Result` the caller already has. To stop the work itself, pass `ctx.request.signal` into it (see [`MiddlewareContext`](#middlewarecontext)).

### Sharing

Set `share: true` on a `Request` to coalesce identical concurrent calls onto a single in-flight request, instead of each caller firing its own:

```ts
const getProduct = new Request<{ id: string }, Product>({
  method: 'GET',
  path: '/products/:id',
  share: true
})

// Only one network request is made; both callers get the same response
const [a, b] = await Promise.all([
  api.getProduct({ id: '42' }),
  api.getProduct({ id: '42' })
])
```

`share` is the sibling of `dedupe`, with the opposite intent: **dedupe cancels** the older call in favor of the newer one, **share joins** the existing call instead of starting a new one. Because the two behaviors contradict each other, setting both on the same `Request` throws at `createApi(...)` time — not at call time — so the mistake surfaces immediately rather than the first time the endpoint is called.

**What counts as "identical":** the request name plus a stable serialization of the params. Two calls with the same params to the same endpoint share; different params (or different endpoints) never do.

**What disables sharing for a single call:**

- A per-call `headers` or `middleware` — these change *what* is requested, so handing that caller another caller's response would be a real bug, not just a missed optimization. A call carrying either always gets its own, unshared request.
- Params that are opaque to the stable serialization — `FormData`, `Blob`, `ArrayBuffer`, `URLSearchParams`, `Date`, `Map`, or `Set` — are never coalesced. The stable serialization used to build the share key can't distinguish two different payloads of these types from each other (it falls back to `Object.keys()`, which is empty for all of them), so two different `FormData` uploads would otherwise collide on the same key and one caller could receive the response meant for the other's payload entirely. Declining to share is always safe; handing back the wrong response never is. A raw `string` is not excluded — it stringifies distinguishably, so a string-param endpoint is soundly coalesced like any other.

**What does *not* disable sharing:** a per-call `signal` or `timeout`. These bound *who is still waiting*, not *what is being asked for*, so they're tracked with a per-caller refcount instead: each sharer's own signal/timeout only removes that caller from the wait list. The underlying request keeps running for everyone else, and is only aborted once every sharer — including the one that gave up — has stopped waiting. A sharer that gives up gets an error `Result` (`kind: 'timeout'` or `kind: 'abort'`), reported to `onError` exactly as the identical non-shared call would be — which means a `'timeout'` give-up reports and an `'abort'` give-up does not (see [Error handling with `onError`](#error-handling-with-onerror)).

**A per-*request* `timeout` is different: it belongs to the operation.** `RequestConfig.timeout` bounds the single shared request itself, measured from when that request started — not from when each caller joined it. Every sharer is therefore bounded by it, a late joiner cannot extend it, and a caller passing `timeout: 0` cannot switch it off for everyone else. Without that, a steadily arriving stream of joiners would keep one socket open indefinitely against a deadline that was supposed to cap it.

```ts
const impatient = api.getProduct({ id: '42' }, { timeout: 20 })   // gives up quickly
const patient = api.getProduct({ id: '42' })                      // keeps waiting

// impatient's early timeout does not cancel the shared request —
// patient still gets a real response.
```

**`result.retry()` on a shared result** re-runs the pipeline using the *acquiring caller's* own per-call options (headers, signal, timeout) — that is, whichever call first started the shared request, not whichever caller happens to invoke `retry()`. This falls out of every non-aborting sharer receiving the literal same `Result` object; it's unavoidable given that design, but worth knowing before relying on it.

**Known limitation:** middleware (global or per-request) that replaces `ctx.request.signal` is re-merged with the *dedupe* signal under `dedupe: true`, but is **not** currently re-merged with the *share* refcount controller. Combining `share` with a signal-replacing middleware means that middleware's signal — not the refcount — ends up controlling the shared request: one sharer's middleware-installed signal could cancel the request for every other sharer. Avoid combining `share: true` with signal-replacing middleware until this is addressed.

### TypeScript

Type inference flows automatically from `Request` generics through `createApi` to the call site. You never annotate the API methods manually.

```ts
// 1. Types are declared on the Request
const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:id'
})

// 2. createApi infers method signatures from the requests record
const api = createApi({
  baseUrl: '/api',
  requests: { getUser }
})

// 3. Call site is fully typed -- no annotations needed
const { data, error } = await api.getUser({ id: '42' })
//      ^? User | null
```

The inference chain works like this:

- `Request<TParams, TResponse>` carries the type info.
- `createApi` uses internal conditional types to pull the `TParams` and `TResponse` generics from each `Request` instance.
- A mapped type transforms the requests record into callable methods: each key becomes `(params: TParams, options?: CallOptions) => Promise<Result<TResponse>>`.
- When `TParams` is `Record<string, never>` (no params), the params argument becomes optional.

All exported types are available for annotation when needed:

```ts
import type {
  Result,
  CallOptions,
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  RequestConfig,
  ApiConfig
} from '@iremlopsum/apify'
```

## GraphQL Client

Use `createGraphQL` when your backend speaks GraphQL. **Everything in the REST API section applies here too** — `retryMiddleware`, `cacheMiddleware`, `logMiddleware`, `dedupe`, per-call `signal`, `onError`, `retry()`, `skipMiddleware`, header merging — all of it works identically for GraphQL operations. The only difference is transport: every operation is sent as an HTTP POST with `{ query, variables }`.

Both clients return the same `Result<T>` shape — `result.data`, `result.error`, `result.response`, and `result.retry` work identically.

```ts
import { createGraphQL, Operation, gql } from '@iremlopsum/apify'

interface Category {
  id: string
  name: string
  status: string
}

const GET_CATEGORY = gql`
  query GetCategory($id: String!) {
    category(id: $id) {
      id
      name
      status
    }
  }
`

const getCategory = new Operation<{ id: string }, Category>({
  operation: GET_CATEGORY,
})

const graphql = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  operations: { getCategory },
  onError: (error) => console.error(error.status, error.body),
})

const { data, error, response, retry } = await graphql.getCategory({ id: '123' })
```

Operations with no variables can be called without arguments. Use `Record<string, never>` as `TVariables` to mark an operation as variable-free:

```ts
const getViewer = new Operation<Record<string, never>, ViewerData>({ operation: GET_VIEWER })
const graphql = createGraphQL({ endpoint, operations: { getViewer } })

const { data } = await graphql.getViewer() // params argument is optional
```

### Queries and mutations

When you want to distinguish queries from mutations in the client structure, use the `queries` and `mutations` keys instead of `operations`. The `operations` flat shape and the `queries`/`mutations` split are mutually exclusive — TypeScript enforces this at compile time.

```ts
const graphql = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  queries: {
    getCategory: new Operation<{ id: string }, Category>({ operation: GET_CATEGORY }),
  },
  mutations: {
    updateCategory: new Operation<{ id: string; name: string }, Category>({
      operation: gql`
        mutation UpdateCategory($id: String!, $name: String!) {
          updateCategory(id: $id, name: $name) { id name status }
        }
      `,
    }),
  },
})

graphql.query.getCategory({ id: '123' })
graphql.mutation.updateCategory({ id: '123', name: 'New Name' })
```

### GraphQL errors

GraphQL errors (any 2xx with `{ errors: [...] }`) surface as `result.error` with the response's own `status` and `error.body` typed as `GraphQLError[]` — no special handling needed. The same `if (error) { ... }` check covers GraphQL errors, HTTP errors, and network errors uniformly.

GraphQL allows **partial success** -- a nullable field errors while the rest of the query resolves. That data is not discarded: it's available as `error.partialData`, never on `result.data` (which stays `null` whenever `error` is non-null, keeping `Result` a clean discriminated union):

```ts
const { error } = await graphql.getCategory({ id: '123' })
if (error) {
  console.log(error.body)          // GraphQLError[]
  console.log(error.partialData)   // whatever `data` the server sent alongside the errors, or undefined
}
```

GraphQL's own empty-success rule mirrors the REST client's: a 2xx response carrying neither `data` nor `errors` is `kind: 'parse'`, not a success with `data: null`. This covers an empty body, `{}`, a literal `{"data": null}`, and a non-object JSON root -- anything that reaches a 2xx without a `data` or `errors` key. `error.body` holds the raw response text, not a parsed value:

```ts
const { error } = await graphql.getCategory({ id: '123' })
if (error) {
  console.log(error.kind) // 'parse'
  console.log(error.body) // raw response text, e.g. '' or '{}'
}
```

A `{"data": null, "errors": [...]}` response is unchanged -- it's still `kind: 'http'`, with any partial result in `error.partialData`, since the GraphQL-errors branch runs first. See [MIGRATION.md](./MIGRATION.md#upgrading-to-400).

Operations support `dedupe: true` in the same way `Request` does — see [Auto-cancel via `dedupe`](#auto-cancel-via-dedupe).

### Middleware

`createGraphQL` accepts the same middleware options as `createApi` — global, per-operation, and per-call — and the `MiddlewareContext` shape is identical, so middleware written for `createApi` works here too.

```ts
const graphql = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  operations: { getCategory },
  middleware: [authMiddleware],
})
```

### API Reference additions

| Export              | Kind     | Description                                                            |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| `createGraphQL`     | function | Creates a typed GraphQL client from a config of Operation definitions  |
| `Operation`         | class    | Typed operation definition -- one instance per GraphQL operation       |
| `gql`               | const    | Tagged template literal for GraphQL documents (editor tooling support) |
| `OperationConfig`   | type     | Config object for the `Operation` constructor                          |
| `GraphQLBaseConfig` | type     | Config object for `createGraphQL`                                      |
| `GraphQLError`      | type     | Shape of a single GraphQL error from `{ errors: [...] }`               |

## Testing

`@iremlopsum/apify/testing` is a separate, framework-agnostic entry point for testing consumers of this library — it has no test-runner dependency, so it works the same under Vitest, Jest, or anything else. It gives you a `fetch` stub with route matching, so your tests exercise the real pipeline — URL building, path substitution, header merging, body serialization, response parsing, your own middleware — rather than stubbing an API method to return a canned `Result` and silently drifting out of sync with what the library actually does.

```ts
import { mockFetch, jsonResponse } from '@iremlopsum/apify/testing'

const mock = mockFetch({
  'GET /api/users/:id': ({ params }) => jsonResponse({ id: params.id, name: 'Ada' }),
  'POST /api/users': jsonResponse({ id: 'new-user' }, { status: 201 }),
})

mock.install()   // replaces globalThis.fetch
// ... exercise your code, which calls the real api.getUser(...) ...
mock.restore()    // puts the original globalThis.fetch back
```

Routes are keyed as `"METHOD /path"`, with `:token` segments captured and handed to a route function as `{ params, request }`. A route value can also be a plain `Response` (built with the `jsonResponse` helper, or your own), or an array of either — the array is consumed one response per matching call, and the final entry repeats once exhausted (handy for "fail twice, then succeed").

```ts
const mock = mockFetch({
  'GET /api/flaky': [jsonResponse(null, { status: 503 }), jsonResponse({ ok: true })],
})
```

`mock.calls` records every request (`{ method, url, headers, body }`); `mock.callCount('GET /api/users/:id')` and `mock.lastCall(...)` key off the same `"METHOD /path"` strings as the routes object.

An unmatched request makes the stub throw rather than invent a 404 — a mocked test should not quietly pass for a typo'd path. Note what your code actually sees, though: the library catches every `fetch` rejection by design, so that throw arrives as an ordinary `Result` with `error.kind === 'network'` and the `Error` itself as `error.body`, whose message names the method, the URL, and every route that was defined. Assert on the result (or read it in `onError`); do not expect the call to reject.

```ts
const r = await api.getUser({ id: '42' })   // routes only define 'GET /api/user/:id'
expect(r.error?.kind).toBe('network')
expect(String(r.error?.body)).toMatch(/no route matched GET \/api\/users\/42/)
```

An empty response array for a route behaves the same way — a descriptive `Error` reaching you as `error.body`, not a bare `TypeError`.

For stubbing at the `Result` level instead of the `fetch` level, `successResult(data)` and `errorResult(status, body)` build a well-formed `Result` directly (shown here with Vitest's `vi.spyOn`, but any runner's equivalent works the same way):

```ts
import { successResult, errorResult } from '@iremlopsum/apify/testing'

vi.spyOn(api, 'getUser').mockResolvedValue(successResult({ id: '42', name: 'Ada' }))
vi.spyOn(api, 'getUser').mockResolvedValue(errorResult(404, { message: 'not found' }))
```

Three behaviors worth knowing:

- **`restore()` assumes `globalThis.fetch` was defined when `install()` ran** — true on Node 20+ (and in every browser), since `fetch` is a global there. If you somehow call `install()` in an environment where `globalThis.fetch` is `undefined` beforehand, `restore()` puts back that `undefined` rather than inventing a real `fetch`.
- **A route key must be `"METHOD /path"`.** A key with no space (`'/users'`) throws at `mockFetch(...)` time, naming the offending key, rather than silently registering a route that can never match.
- **Declaration order decides when two same-length routes could both match.** Routes are matched in the order they appear in the object you pass to `mockFetch`, and the first structural match wins — put more specific routes first if two patterns could both match the same path.
- **Trailing and duplicate slashes are normalized away on both sides.** `/a/b/`, `/a//b`, and `/a/b` all match the same route, whether the extra slash is in the route key or in the URL the library actually built.

## Philosophy

### Never throws

Every API call returns a `Result<T>`. HTTP errors, network failures, parse errors, and even synchronous exceptions during request setup are all captured and returned as structured `{ data, error, response, retry }` objects. No try/catch required at call sites.

### Zero dependencies

The library uses only the standard `fetch` API and built-in web platform types (`Headers`, `AbortController`, `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`). There is nothing to install, audit, or bundle beyond the library itself.

### Middleware over interceptors

Instead of separate `onRequest`/`onResponse` interceptor hooks, the library uses a composable onion model where each middleware wraps the next. This means a single function can modify the request, inspect the response, retry on failure, or short-circuit entirely. Three layers (global, per-request, per-call) plus `skipMiddleware` give fine-grained control without configuration complexity.

### Typed dot-access

Type safety comes from inference, not annotation. Define `Request<TParams, TResponse>` once, and `createApi` infers everything downstream. The call site (`api.getUser(...)`) is fully typed with zero extra work.

### Runtime-agnostic

No assumptions about Node.js, browsers, or any specific runtime. If your environment has `fetch`, the library works -- browsers, Node.js 20+, Bun, Deno, React Native, Cloudflare Workers, edge runtimes.

## API Reference

### Core (`@iremlopsum/apify`)

| Export          | Kind     | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `createApi`     | function | Creates a typed API client from a config of Request definitions    |
| `Request`       | class    | Typed endpoint definition -- one instance per endpoint             |
| `defineRequest` | function | Typed factory — infers path params from the `path` literal, and enforces `responseType: 'none'`. |
| `paginate` | function | Walks a paginated endpoint, yielding one `Result` per page. |
| `PaginateOptions` | type | `next`, `maxPages`, and any `CallOptions`. |
| `StandardSchemaV1` | type | The Standard Schema contract — for typing a helper that takes a validator. |
| `InferOutput`      | type | The type a schema produces on success. |
| `StandardIssue`    | type | One validation failure -- the shape of each entry in `error.body` when a schema refuses. |
| `ApiError`      | class    | Structured error with status, kind, body, headers, and request metadata |
| `ApiErrorKind`  | type     | `'http' \| 'network' \| 'abort' \| 'timeout' \| 'parse' \| 'middleware'` -- discriminates `ApiError.kind` |
| `RequestConfig` | type     | Config object for the `Request` constructor                        |
| `ApiConfig`     | type     | Config object for `createApi`                                      |
| `CallOptions`   | type     | Per-call overrides (`middleware`, `skipMiddleware`, `headers`, `signal`, `timeout`) |
| `Result`        | type     | Discriminated union of every API call's outcome: `SuccessResult<T> \| ErrorResult<T>` |
| `SuccessResult` | type     | The success branch of `Result`: `{ data: T, error: null, response: Response, retry }` |
| `ErrorResult`   | type     | The error branch of `Result`: `{ data: null, error: ApiError, response: Response \| null, retry }` |
| `Middleware`    | type     | Middleware function signature: `(ctx, next) => Promise<Result>`    |
| `MiddlewareContext` | type | Request context passed to middleware                               |
| `MiddlewareNext` | type    | The `next` function passed to middleware                           |
| `createGraphQL`     | function | Creates a typed GraphQL client from a config of Operation definitions  |
| `Operation`         | class    | Typed operation definition -- one instance per GraphQL operation       |
| `gql`               | const    | Tagged template literal for GraphQL documents (editor tooling support) |
| `OperationConfig`   | type     | Config object for the `Operation` constructor                          |
| `GraphQLBaseConfig` | type     | Config object for `createGraphQL`                                      |
| `GraphQLError`      | type     | Shape of a single GraphQL error from `{ errors: [...] }`              |

### Built-in middleware (`@iremlopsum/apify/middleware`)

| Export            | Kind     | Description                                                   |
| ----------------- | -------- | ------------------------------------------------------------- |
| `retryMiddleware` | function | Factory that returns middleware retrying on 5xx by default, with a configurable backoff policy |
| `RetryOptions`    | type     | Options object accepted by `retryMiddleware` (`max`, `delay`, `baseDelay`, `maxDelay`, `jitter`, `respectRetryAfter`, `retryOn`, `onRetry`) |
| `RetryInfo`       | type     | Shape of the argument passed to `RetryOptions.onRetry`         |
| `logMiddleware`   | const    | Middleware that logs request lifecycle to the console          |
| `cacheMiddleware` | function | Factory that returns a per-request in-memory cache with `clear()` |
| `CacheMiddleware` | type     | Return type of `cacheMiddleware()` -- a `Middleware` with an attached `clear()` |

### Testing (`@iremlopsum/apify/testing`)

| Export          | Kind     | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `mockFetch`     | function | Builds a route-matching `fetch` stub, with `install()`/`restore()`, call recording, and response sequencing |
| `jsonResponse`  | function | Builds a `Response` with a JSON body and a `content-type` header, for use as a route value |
| `successResult` | function | Builds a well-formed success `Result<T>` directly, for stubbing at the `Result` level |
| `errorResult`   | function | Builds a well-formed error `Result<T>` with a given HTTP status, for stubbing at the `Result` level |
| `RouteContext`  | type     | `{ params, request }` passed to a route handler function          |
| `RouteHandler`  | type     | `(ctx: RouteContext) => Response \| Promise<Response>` -- a route value that computes its response |
| `RouteValue`    | type     | `Response \| RouteHandler \| Array<Response \| RouteHandler>` -- anything a route key can map to |
| `RecordedCall`  | type     | `{ method, url, headers, body }` -- shape of each entry in `mock.calls` |

## License

MIT
