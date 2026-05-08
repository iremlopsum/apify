# apify

Runtime-agnostic, type-safe API client built on standard `fetch`. Zero dependencies.

```
npm install @iremlopsum/apify
```

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

## Deep Dive

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

### Query strings

For GET and DELETE requests (or any request with `bodyAs: 'query'`), params that are not consumed by path substitution are serialized as a query string using `URLSearchParams`.

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

Every API call returns a `Result<TResponse>` instead of throwing. The shape is always the same:

```ts
interface Result<TResponse> {
  data: TResponse | null    // parsed response on success, null on error
  error: ApiError | null     // structured error on failure, null on success
  response: Response | null  // raw fetch Response (null for network errors)
  retry: () => Promise<Result<TResponse>>
}
```

Check `error` first, then use `data` with confidence:

```ts
const { data, error, response, retry } = await api.getUser({ id: '42' })

if (error) {
  if (error.status === 0) {
    // Network error -- user is probably offline
  } else if (error.status === 401) {
    redirectToLogin()
  } else {
    console.error(error.status, error.body)
  }
  return
}

// data is typed as User, error is null
console.log(data.name)
```

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
| `status`     | `number`  | HTTP status code (e.g., 404, 500). `0` for network errors/aborts. |
| `statusText` | `string`  | HTTP status text (e.g., 'Not Found'). `''` for network errors.    |
| `body`       | `unknown` | Parsed response body, or the native Error for network failures.   |
| `headers`    | `Headers` | Response headers. Empty `Headers` for network errors.             |
| `request`    | `object`  | `{ method, url, params }` -- metadata about the failed request.   |

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

This fires for both HTTP errors (4xx, 5xx) and network errors (status 0). It is a global hook for side effects (logging, telemetry, redirects) -- it does not change the result returned to the caller.

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
| `requestName`         | `string`  | Key name in the requests object (e.g., 'getUser')        |

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

The library ships two optional middleware functions, importable from a separate entry point:

```ts
import { retryMiddleware, logMiddleware } from '@iremlopsum/apify/middleware'
```

**`retryMiddleware(maxRetries?: number)`**

Automatically retries requests that return a 5xx server error. The `maxRetries` parameter (default: 3) is the number of additional attempts after the initial one, so `retryMiddleware(2)` means up to 3 total attempts.

Only retries server errors (status >= 500). Client errors (4xx) and network errors (status 0) are not retried.

```ts
const api = createApi({
  baseUrl: '/api',
  requests: { getItems },
  middleware: [retryMiddleware(2)]
})
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

The default is `'json'`. JSON parsing reads the body as text first and then parses, so empty responses (e.g., 204 No Content) return `null` instead of throwing a parse error.

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
// error.status === 0, error.body is a DOMException with name 'AbortError'
```

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

Use `createGraphQL` when your backend speaks GraphQL. It shares the same `Result<T>` shape, middleware model, and error contract as `createApi` — `result.data`, `result.error`, `result.retry` work identically.

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

const { data, error } = await graphql.getCategory({ id: '123' })
```

### Queries and mutations

When you want to distinguish queries from mutations in the client structure, use the `queries` and `mutations` keys instead of `operations`. The two shapes are mutually exclusive — TypeScript enforces this at compile time.

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

GraphQL errors (HTTP 200 with `{ errors: [...] }`) surface as `result.error` with `status: 200` and `body` set to the errors array — no special handling needed. The same `if (error) { ... }` check covers GraphQL errors, HTTP errors, and network errors uniformly.

### Middleware

`createGraphQL` accepts the same middleware options as `createApi` — global, per-operation, and per-call — and the `MiddlewareContext` shape is identical, so middleware written for `createApi` works here too.

```ts
const graphql = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  operations: { getCategory },
  middleware: [authMiddleware, logMiddleware],
})
```

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

No assumptions about Node.js, browsers, or any specific runtime. If your environment has `fetch`, the library works -- browsers, Node.js 18+, Bun, Deno, React Native, Cloudflare Workers, edge runtimes.

## API Reference

### Core (`@iremlopsum/apify`)

| Export          | Kind     | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `createApi`     | function | Creates a typed API client from a config of Request definitions    |
| `Request`       | class    | Typed endpoint definition -- one instance per endpoint             |
| `ApiError`      | class    | Structured error with status, body, headers, and request metadata  |
| `RequestConfig` | type     | Config object for the `Request` constructor                        |
| `ApiConfig`     | type     | Config object for `createApi`                                      |
| `CallOptions`   | type     | Per-call overrides (middleware, headers, signal)                   |
| `Result`        | type     | Return shape of every API call: `{ data, error, response, retry }` |
| `Middleware`    | type     | Middleware function signature: `(ctx, next) => Promise<Result>`    |
| `MiddlewareContext` | type | Request context passed to middleware                               |
| `MiddlewareNext` | type    | The `next` function passed to middleware                           |
| `createGraphQL`     | function | Creates a typed GraphQL client from a config of Operation definitions   |
| `Operation`         | class    | Typed operation definition — one instance per GraphQL operation         |
| `gql`               | function | Tagged template literal for GraphQL documents (editor tooling support)  |
| `OperationConfig`   | type     | Config object for the `Operation` constructor                           |
| `GraphQLBaseConfig` | type     | Config object for `createGraphQL`                                       |
| `GraphQLError`      | type     | Shape of a single GraphQL error from `{ errors: [...] }`               |

### Built-in middleware (`@iremlopsum/apify/middleware`)

| Export            | Kind     | Description                                                   |
| ----------------- | -------- | ------------------------------------------------------------- |
| `retryMiddleware` | function | Factory that returns middleware to retry on 5xx server errors  |
| `logMiddleware`   | const    | Middleware that logs request lifecycle to the console          |

## License

MIT
