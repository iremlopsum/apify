# GraphQL Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createGraphQL`, `Operation`, and `gql` to `@iremlopsum/apify` — a type-safe GraphQL client that shares the same `Result<T>` shape, middleware model, and error contract as `createApi`.

**Architecture:** Standalone `createGraphQL` factory in a new `src/graphql.ts` file, sharing low-level utilities (`composeMiddleware`, `DedupeTracker`, Result factories, a newly-extracted `mergeHeaders`) with `createApi` but not wrapping it. The execution loop is simpler than `createApi` — always POST, always JSON, GraphQL error detection built into the core layer. Type safety comes from two overloaded signatures: one for a flat `operations` API, one for a namespaced `queries`/`mutations` API.

**Tech Stack:** TypeScript, vitest (tests), standard fetch API.

---

### Task 1: Extract `mergeHeaders` to `src/utils/headers.ts`

`mergeHeaders` currently lives as a private function in `src/create-api.ts`. `src/graphql.ts` needs the same function, so extract it to a shared utility first. No behavior change — existing tests cover it.

**Files:**
- Create: `src/utils/headers.ts`
- Modify: `src/create-api.ts` (remove local definition, add import)

- [ ] **Step 1: Create `src/utils/headers.ts`**

```ts
export function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const source of sources) {
    if (!source) continue
    const entries: Iterable<[string, string]> =
      source instanceof Headers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (source as any).entries()
        : Array.isArray(source)
          ? source
          : Object.entries(source)
    for (const [key, value] of entries) {
      merged.set(key, value)
    }
  }
  return merged
}
```

- [ ] **Step 2: Update `src/create-api.ts` — replace local function with import**

Remove lines 153–175 (the `mergeHeaders` function body and its JSDoc comment) and add an import at the top of the imports section:

```ts
import { mergeHeaders } from './utils/headers.js'
```

The rest of `create-api.ts` is unchanged — `mergeHeaders` is called the same way throughout.

- [ ] **Step 3: Run existing tests to verify no regressions**

```bash
npm run test:run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/utils/headers.ts src/create-api.ts
git commit -m "refactor: extract mergeHeaders to shared utility"
```

---

### Task 2: Add GraphQL types to `src/types.ts`

Add three new interfaces at the bottom of `src/types.ts`, after the `ApiConfig` section. The complex mapped types (`FlatClient`, `SplitClient`, etc.) live in `src/graphql.ts` because they reference `Operation`, which would create a circular import if placed here.

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append to `src/types.ts` after the `ApiConfig` interface**

```ts
// ---------------------------------------------------------------------------
// GraphQL Types
// ---------------------------------------------------------------------------

/**
 * Configuration object for the `Operation` class constructor.
 *
 * The `operation` field holds the GraphQL document string. It is sent to the
 * server under the key `"query"` (per the GraphQL over HTTP spec), but is
 * named `operation` here to make clear it can be a query or mutation.
 */
export interface OperationConfig {
  /** The GraphQL document string. Sent as `{ query: ... }` on the wire. */
  operation: string
  middleware?: Middleware[]
  headers?: HeadersInit
  dedupe?: boolean
}

/**
 * A single GraphQL error as returned by the server in `{ errors: [...] }`.
 * Mirrors the GraphQL spec error shape.
 */
export interface GraphQLError {
  message: string
  locations?: Array<{ line: number; column: number }>
  path?: Array<string | number>
  extensions?: Record<string, unknown>
}

/**
 * Base configuration shared by both `createGraphQL` overloads.
 */
export interface GraphQLBaseConfig {
  /** The full URL of the GraphQL endpoint, e.g. `'https://api.example.com/graphql'`. */
  endpoint: string
  middleware?: Middleware[]
  headers?: HeadersInit
  onError?: (error: ApiError) => void
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add GraphQL types to types.ts"
```

---

### Task 3: `Operation` class and `gql` tag (TDD)

**Files:**
- Create: `src/graphql.ts`
- Create: `tests/create-graphql.test.ts`

- [ ] **Step 1: Create `tests/create-graphql.test.ts` with tests for `Operation` and `gql`**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Operation, gql } from '../src/graphql.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Operation', () => {
  it('stores the operation string', () => {
    const op = new Operation<{ id: string }, { name: string }>({
      operation: 'query GetUser($id: String!) { user(id: $id) { name } }',
    })
    expect(op.config.operation).toBe('query GetUser($id: String!) { user(id: $id) { name } }')
  })

  it('stores optional config fields', () => {
    const mw = vi.fn()
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: 'query { health }',
      dedupe: true,
      headers: { 'X-Custom': 'yes' },
      middleware: [mw],
    })
    expect(op.config.dedupe).toBe(true)
    expect(op.config.headers).toEqual({ 'X-Custom': 'yes' })
    expect(op.config.middleware).toEqual([mw])
  })
})

describe('gql', () => {
  it('returns the template string unchanged', () => {
    const query = gql`query GetUser($id: String!) { user(id: $id) { id name } }`
    expect(query).toBe('query GetUser($id: String!) { user(id: $id) { id name } }')
  })

  it('interpolates values', () => {
    const fields = 'id name'
    const query = gql`query { user { ${fields} } }`
    expect(query).toBe('query { user { id name } }')
  })
})
```

- [ ] **Step 2: Run tests — expect failure (module not found)**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: FAIL — `Cannot find module '../src/graphql.js'`.

- [ ] **Step 3: Create `src/graphql.ts` with `Operation` and `gql`**

```ts
import type { OperationConfig } from './types.js'

export class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  constructor(config: OperationConfig) {
    this.config = config
  }
}

export const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graphql.ts tests/create-graphql.test.ts
git commit -m "feat: add Operation class and gql tag"
```

---

### Task 4: `createGraphQL` — happy path (flat and split APIs)

Implement the full `createGraphQL` factory including the execution loop. Error handling, middleware, dedupe are all part of the execution loop — implemented here in full. Tests are added incrementally to drive the implementation.

**Files:**
- Modify: `src/graphql.ts`
- Modify: `tests/create-graphql.test.ts`

- [ ] **Step 1: Add flat-API (operations) happy path tests**

Add this `describe` block to `tests/create-graphql.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Operation, gql, createGraphQL } from '../src/graphql.js'

// ... (keep existing Operation and gql tests above)

describe('createGraphQL — flat operations', () => {
  it('sends POST to the endpoint with { query, variables } body', async () => {
    const GET_USER = gql`query GetUser($id: String!) { user(id: $id) { id name } }`
    const getUser = new Operation<{ id: string }, { id: string; name: string }>({
      operation: GET_USER,
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '42', name: 'Alice' } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error } = await client.getUser({ id: '42' })

    expect(error).toBeNull()
    expect(data).toEqual({ id: '42', name: 'Alice' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/graphql',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: GET_USER, variables: { id: '42' } }),
      })
    )
  })

  it('sets Content-Type: application/json automatically', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    await client.health()

    const headers: Headers = mockFetch.mock.calls[0][1].headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })
})

describe('createGraphQL — split queries/mutations', () => {
  it('nests operations under client.query and client.mutation', async () => {
    const GET_USER = gql`query GetUser($id: String!) { user(id: $id) { id } }`
    const UPDATE_USER = gql`mutation UpdateUser($id: String!, $name: String!) { updateUser(id: $id, name: $name) { id } }`

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      queries: {
        getUser: new Operation<{ id: string }, { id: string }>({ operation: GET_USER }),
      },
      mutations: {
        updateUser: new Operation<{ id: string; name: string }, { id: string }>({ operation: UPDATE_USER }),
      },
    })

    const { data: queryData } = await client.query.getUser({ id: '1' })
    const { data: mutationData } = await client.mutation.updateUser({ id: '1', name: 'Bob' })

    expect(queryData).toEqual({ id: '1' })
    expect(mutationData).toEqual({ id: '1' })
  })

  it('exposes only client.query when only queries are provided', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      queries: { getUser: op },
    })

    expect(client).toHaveProperty('query.getUser')
    expect(client).not.toHaveProperty('mutation')
  })

  it('exposes only client.mutation when only mutations are provided', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`mutation DeleteUser($id: String!) { deleteUser(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      mutations: { deleteUser: op },
    })

    expect(client).toHaveProperty('mutation.deleteUser')
    expect(client).not.toHaveProperty('query')
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: FAIL — `createGraphQL is not a function` (not exported yet).

- [ ] **Step 3: Implement `createGraphQL` in `src/graphql.ts`**

Replace the file contents with the full implementation:

```ts
import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from './result.js'
import { composeMiddleware } from './middleware.js'
import { DedupeTracker } from './utils/dedupe.js'
import { mergeHeaders } from './utils/headers.js'
import type { CallOptions, Middleware, MiddlewareContext, Result, GraphQLBaseConfig, OperationConfig } from './types.js'

// ---------------------------------------------------------------------------
// Operation — typed config container for GraphQL operations
// ---------------------------------------------------------------------------

export class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  constructor(config: OperationConfig) {
    this.config = config
  }
}

// ---------------------------------------------------------------------------
// gql — tagged template literal for editor tooling support
// ---------------------------------------------------------------------------

export const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)

// ---------------------------------------------------------------------------
// Internal type helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphQLMethod<TVariables extends object, TData> =
  Record<string, never> extends TVariables
    ? (variables?: TVariables, options?: CallOptions) => Promise<Result<TData>>
    : (variables: TVariables, options?: CallOptions) => Promise<Result<TData>>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlatClient<TOperations> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof TOperations]: TOperations[K] extends Operation<infer V, infer D>
    ? GraphQLMethod<V, D>
    : never
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SplitClient<TQ, TM> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TQ extends Record<string, Operation<any, any>> ? { query: FlatClient<TQ> } : {}) &
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TM extends Record<string, Operation<any, any>> ? { mutation: FlatClient<TM> } : {})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithOperations<T> = GraphQLBaseConfig & {
  operations: T
  queries?: never
  mutations?: never
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithSplit<TQ, TM> = GraphQLBaseConfig & {
  operations?: never
  queries?: TQ
  mutations?: TM
}

// ---------------------------------------------------------------------------
// createGraphQL — overloaded factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGraphQL<T extends Record<string, Operation<any, any>>>(
  config: WithOperations<T>
): FlatClient<T>
export function createGraphQL<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TQ extends Record<string, Operation<any, any>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TM extends Record<string, Operation<any, any>>
>(config: WithSplit<TQ, TM>): SplitClient<TQ, TM>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGraphQL(config: any): any {
  const {
    endpoint,
    middleware: globalMiddleware = [],
    headers: globalHeaders,
    onError,
  } = config

  const dedupeTracker = new DedupeTracker()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildMethod(name: string, operation: Operation<any, any>) {
    return (variables: object = {}, options: CallOptions = {}): Promise<Result<unknown>> => {
      const execute = (): Promise<Result<unknown>> => {
        try {
          const allMiddleware: Middleware[] = [
            ...globalMiddleware,
            ...(operation.config.middleware ?? []),
            ...(options.middleware ?? []),
          ]

          let effectiveSignal: AbortSignal | undefined = options.signal
          if (operation.config.dedupe) {
            effectiveSignal = dedupeTracker.track(name, options.signal)
          }

          const core = async (ctx: MiddlewareContext): Promise<Result<unknown>> => {
            try {
              const response = await fetch(ctx.request.url, {
                method: 'POST',
                headers: ctx.request.headers,
                body: ctx.request.body as string,
                signal: effectiveSignal,
              })

              if (!response.ok) {
                let body: unknown
                try {
                  const text = await response.text()
                  body = text ? JSON.parse(text) : null
                } catch {
                  body = null
                }
                const error = new ApiError({
                  status: response.status,
                  statusText: response.statusText,
                  body,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              const text = await response.text()
              const gqlBody = text
                ? (JSON.parse(text) as { data?: unknown; errors?: unknown[] })
                : null

              if (gqlBody?.errors?.length) {
                const error = new ApiError({
                  status: 200,
                  statusText: 'GraphQL Error',
                  body: gqlBody.errors,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              return createSuccessResult(gqlBody?.data ?? null, response, execute)
            } catch (err) {
              const error = new ApiError({
                status: 0,
                statusText: '',
                body: err,
                headers: new Headers(),
                request: { method: 'POST', url: ctx.request.url, params: variables },
              })
              return createNetworkErrorResult(error, execute)
            }
          }

          const headers = mergeHeaders(globalHeaders, operation.config.headers, options.headers)
          if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json')
          }

          const body = JSON.stringify({ query: operation.config.operation, variables })

          const context: MiddlewareContext = {
            request: {
              method: 'POST',
              url: endpoint,
              path: endpoint,
              params: variables,
              headers,
              body,
            },
            requestName: name,
          }

          const composed = composeMiddleware(allMiddleware, core, options.skipMiddleware ?? [])
          return composed(context).then(result => {
            if (operation.config.dedupe) dedupeTracker.clear(name)
            if (result.error && onError) onError(result.error as ApiError)
            return result
          })
        } catch (err) {
          const error = new ApiError({
            status: 0,
            statusText: '',
            body: err,
            headers: new Headers(),
            request: { method: 'POST', url: endpoint, params: variables },
          })
          if (onError) onError(error)
          return Promise.resolve(createNetworkErrorResult(error, execute))
        }
      }

      return execute()
    }
  }

  // Flatten all operations into a single name → method map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allOperations: Record<string, Operation<any, any>> = {
    ...(config.operations ?? {}),
    ...(config.queries ?? {}),
    ...(config.mutations ?? {}),
  }

  const flatMethods: Record<string, Function> = {}
  for (const [name, operation] of Object.entries(allOperations)) {
    flatMethods[name] = buildMethod(name, operation)
  }

  // Flat API: return methods at the top level
  if (config.operations) {
    return flatMethods
  }

  // Split API: nest under query / mutation namespaces
  const result: Record<string, Record<string, Function>> = {}
  if (config.queries) {
    result.query = {}
    for (const name of Object.keys(config.queries)) {
      result.query[name] = flatMethods[name]
    }
  }
  if (config.mutations) {
    result.mutation = {}
    for (const name of Object.keys(config.mutations)) {
      result.mutation[name] = flatMethods[name]
    }
  }
  return result
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graphql.ts tests/create-graphql.test.ts
git commit -m "feat: implement createGraphQL factory with flat and split APIs"
```

---

### Task 5: Error handling tests

The error handling is already implemented in `core`. This task adds the tests to prove it works correctly.

**Files:**
- Modify: `tests/create-graphql.test.ts`

- [ ] **Step 1: Add error handling tests to `tests/create-graphql.test.ts`**

Append the following `describe` blocks:

```ts
describe('createGraphQL — GraphQL errors (HTTP 200 with { errors })', () => {
  it('maps GraphQL errors to result.error, result.data is null', async () => {
    const getUser = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({
        data: null,
        errors: [{ message: 'User not found' }],
      })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error, response } = await client.getUser({ id: '99' })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.status).toBe(200)
    expect(error?.statusText).toBe('GraphQL Error')
    expect(error?.body).toEqual([{ message: 'User not found' }])
    expect(response).not.toBeNull()
  })
})

describe('createGraphQL — HTTP errors (4xx/5xx)', () => {
  it('maps a 404 response to result.error', async () => {
    const getUser = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ message: 'Not found' })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error, response } = await client.getUser({ id: '99' })

    expect(data).toBeNull()
    expect(error?.status).toBe(404)
    expect(error?.body).toEqual({ message: 'Not found' })
    expect(response?.status).toBe(404)
  })

  it('maps a 500 response to result.error', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      text: () => Promise.resolve(''),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    const { data, error } = await client.health()

    expect(data).toBeNull()
    expect(error?.status).toBe(500)
    expect(error?.body).toBeNull()
  })
})

describe('createGraphQL — network errors', () => {
  it('maps a network failure to result.error with status 0, response is null', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    const { data, error, response } = await client.health()

    expect(data).toBeNull()
    expect(error?.status).toBe(0)
    expect(error?.body).toBeInstanceOf(TypeError)
    expect(response).toBeNull()
  })
})

describe('createGraphQL — onError callback', () => {
  it('fires onError for GraphQL errors', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'Oops' }] })),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
      onError,
    })

    await client.getUser({ id: '1' })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(200)
  })

  it('fires onError for HTTP errors', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(),
      text: () => Promise.resolve(''),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
      onError,
    })

    await client.getUser({ id: '1' })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(401)
  })

  it('fires onError for network errors', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      onError,
    })

    await client.health()

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(0)
  })

  it('does NOT fire onError on success', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      onError,
    })

    const { error } = await client.health()

    expect(error).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests — expect all to pass**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/create-graphql.test.ts
git commit -m "test: add error handling and onError tests for createGraphQL"
```

---

### Task 6: Middleware, `skipMiddleware`, and `retry()` tests

**Files:**
- Modify: `tests/create-graphql.test.ts`

- [ ] **Step 1: Add middleware and retry tests**

Append to `tests/create-graphql.test.ts`:

```ts
describe('createGraphQL — middleware', () => {
  it('runs global → per-operation → per-call middleware in order', async () => {
    const order: string[] = []
    const globalMw = vi.fn(async (ctx: any, next: any) => { order.push('global'); return next() })
    const opMw = vi.fn(async (ctx: any, next: any) => { order.push('operation'); return next() })
    const callMw = vi.fn(async (ctx: any, next: any) => { order.push('call'); return next() })

    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
      middleware: [opMw],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [globalMw],
    })

    await client.health({}, { middleware: [callMw] })

    expect(order).toEqual(['global', 'operation', 'call'])
  })

  it('middleware can modify request headers', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const authMw = vi.fn(async (ctx: any, next: any) => {
      ctx.request.headers.set('Authorization', 'Bearer token123')
      return next()
    })

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [authMw],
    })

    await client.health()

    const headers: Headers = mockFetch.mock.calls[0][1].headers
    expect(headers.get('Authorization')).toBe('Bearer token123')
  })

  it('skipMiddleware excludes middleware by reference', async () => {
    const mw = vi.fn(async (ctx: any, next: any) => next())
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [mw],
    })

    await client.health({}, { skipMiddleware: [mw] })

    expect(mw).not.toHaveBeenCalled()
  })
})

describe('createGraphQL — retry()', () => {
  it('retry() re-enters the full execution pipeline', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers(),
          text: () => Promise.resolve(''),
        })
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
      })
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
    })

    const firstResult = await client.getUser({ id: '1' })
    expect(firstResult.error?.status).toBe(503)

    const retryResult = await firstResult.retry()
    expect(retryResult.data).toEqual({ id: '1' })
    expect(retryResult.error).toBeNull()
    expect(callCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests — expect all to pass**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/create-graphql.test.ts
git commit -m "test: add middleware, skipMiddleware, and retry tests for createGraphQL"
```

---

### Task 7: `dedupe` tests

**Files:**
- Modify: `tests/create-graphql.test.ts`

- [ ] **Step 1: Add dedupe test**

Append to `tests/create-graphql.test.ts`:

```ts
describe('createGraphQL — dedupe', () => {
  it('aborts the previous in-flight request when the same operation is called again', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
      dedupe: true,
    })

    let firstCallSignal: AbortSignal | undefined
    let callCount = 0

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++
      if (callCount === 1) {
        firstCallSignal = init.signal as AbortSignal
        return new Promise(() => {}) // hangs forever
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: { id: '2' } })),
      })
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
    })

    // First call: hangs. Don't await.
    client.getUser({ id: '1' })

    // Second call: should abort the first
    await client.getUser({ id: '2' })

    expect(firstCallSignal?.aborted).toBe(true)
    expect(callCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests — expect pass**

```bash
npx vitest run tests/create-graphql.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run full test suite to verify no regressions**

```bash
npm run test:run
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/create-graphql.test.ts
git commit -m "test: add dedupe test for createGraphQL"
```

---

### Task 8: Exports from `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add GraphQL exports to `src/index.ts`**

Add these two lines to `src/index.ts` after the existing exports:

```ts
export { createGraphQL, Operation, gql } from './graphql.js'
export type { GraphQLError, OperationConfig, GraphQLBaseConfig } from './types.js'
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
npm run test:run
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: export createGraphQL, Operation, gql from core entry point"
```

---

### Task 9: README documentation

Add a "GraphQL Client" section to `README.md` between the "Deep Dive" section and "Philosophy". Match the existing README's style: concise examples first, brief explanation after.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert the GraphQL section**

Find the line `## Philosophy` in `README.md` and insert the following block immediately before it:

````markdown
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

### API Reference additions

| Export            | Kind     | Description                                                             |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `createGraphQL`   | function | Creates a typed GraphQL client from a config of Operation definitions   |
| `Operation`       | class    | Typed operation definition — one instance per GraphQL operation         |
| `gql`             | function | Tagged template literal for GraphQL documents (editor tooling support)  |
| `OperationConfig` | type     | Config object for the `Operation` constructor                           |
| `GraphQLBaseConfig` | type   | Config object for `createGraphQL`                                       |
| `GraphQLError`    | type     | Shape of a single GraphQL error from `{ errors: [...] }`                |

````

- [ ] **Step 2: Update the existing API Reference table in `README.md`**

In the `### Core (@iremlopsum/apify)` table (around line 571), add these rows after the existing entries:

```markdown
| `createGraphQL`   | function | Creates a typed GraphQL client from a config of Operation definitions   |
| `Operation`       | class    | Typed operation definition — one instance per GraphQL operation         |
| `gql`             | function | Tagged template literal for GraphQL documents (editor tooling support)  |
| `OperationConfig` | type     | Config object for the `Operation` constructor                           |
| `GraphQLBaseConfig` | type   | Config object for `createGraphQL`                                       |
| `GraphQLError`    | type     | Shape of a single GraphQL error from `{ errors: [...] }`                |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add GraphQL client section to README"
```

---

## Self-review

**Spec coverage check:**
- ✅ `Operation` class with `OperationConfig` (Tasks 2, 3)
- ✅ `gql` tag (Task 3)
- ✅ `createGraphQL` flat API via `operations` (Task 4)
- ✅ `createGraphQL` split API via `queries`/`mutations` (Task 4)
- ✅ Mutual exclusivity enforced by TypeScript `never` trick (Task 4 types)
- ✅ `FlatClient` return type with autocomplete (Task 4 types)
- ✅ `SplitClient` return type with `client.query.*` / `client.mutation.*` (Task 4 types)
- ✅ GraphQL error detection (HTTP 200 with errors) → `result.error` (Task 5)
- ✅ HTTP errors → `result.error` (Task 5)
- ✅ Network errors → `result.error`, `result.response` null (Task 5)
- ✅ `onError` fires for all three error types, not on success (Task 5)
- ✅ Middleware composition global → per-operation → per-call (Task 6)
- ✅ `skipMiddleware` by reference (Task 6)
- ✅ `retry()` re-enters full pipeline (Task 6)
- ✅ `dedupe` cancels previous in-flight request (Task 7)
- ✅ Exports from `src/index.ts` (Task 8)
- ✅ README documentation (Task 9)
- ✅ `mergeHeaders` shared via `src/utils/headers.ts` (Task 1)

**Type consistency check:**
- `OperationConfig.operation: string` — used consistently in all tasks
- `Operation<TVariables, TData>` — matches across test and implementation code
- `FlatClient` / `SplitClient` — only in `src/graphql.ts`, no cross-file type drift
- `GraphQLBaseConfig` / `OperationConfig` / `GraphQLError` — defined in Task 2, used in Task 3+
