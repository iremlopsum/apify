# GraphQL Client Design

**Date:** 2026-05-08  
**Status:** Approved  

## Overview

Add `createGraphQL`, `Operation`, and `gql` to the core entry point of `@iremlopsum/apify`. This gives consumers a type-safe, ergonomic GraphQL client that sits on top of the same execution infrastructure as `createApi` but with a purpose-built loop optimised for GraphQL's transport characteristics (always POST, always JSON, single endpoint, `{ data, errors }` envelope).

## Scope

- New file: `src/graphql.ts`
- Modified: `src/types.ts` (new types), `src/index.ts` (new exports)
- New test file: `tests/create-graphql.test.ts`
- No changes to existing `createApi`, `Request`, or middleware

Out of scope: subscriptions (require WebSockets), schema-driven type generation, persisted queries.

## New Primitives

### `gql` tagged template literal

Returns the template string as-is. Exists purely for editor syntax highlighting and GraphQL tooling support — zero runtime cost.

```ts
const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)
```

### `Operation<TVariables, TData>` class

A typed config container — mirrors `Request` but strips out REST-specific fields. No `method` (always POST), no `path` (always the endpoint), no `bodyAs`, no `responseType`.

```ts
interface OperationConfig {
  operation: string     // the GraphQL document string (sent as { query: ... } on the wire)
  middleware?: Middleware[]
  headers?: HeadersInit
  dedupe?: boolean
}

class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  constructor(config: OperationConfig) { this.config = config }
}
```

## Config Shape

`createGraphQL` enforces mutual exclusivity between `operations` and `queries`/`mutations` at the TypeScript level using the `never` trick:

```ts
type GraphQLBaseConfig = {
  endpoint: string
  middleware?: Middleware[]
  headers?: HeadersInit
  onError?: (error: ApiError) => void
}

// Flat API — client.operationName()
type WithOperations<T> = GraphQLBaseConfig & {
  operations: T
  queries?: never
  mutations?: never
}

// Namespaced API — client.query.name() / client.mutation.name()
type WithSplit<TQ, TM> = GraphQLBaseConfig & {
  operations?: never
  queries?: TQ
  mutations?: TM
}
```

Mixing `operations` with `queries` or `mutations` is a compile-time error.

## Return Types

```ts
type GraphQLMethod<TVariables extends object, TData> =
  Record<string, never> extends TVariables
    ? (variables?: TVariables, options?: CallOptions) => Promise<Result<TData>>
    : (variables: TVariables, options?: CallOptions) => Promise<Result<TData>>

type FlatClient<TOperations> = {
  [K in keyof TOperations]: TOperations[K] extends Operation<infer V, infer D>
    ? GraphQLMethod<V, D>
    : never
}

type SplitClient<TQ, TM> =
  (TQ extends Record<string, Operation<any, any>> ? { query: FlatClient<TQ> } : {}) &
  (TM extends Record<string, Operation<any, any>> ? { mutation: FlatClient<TM> } : {})
```

Function overloads select the correct return type at the call site:

```ts
function createGraphQL<T extends Record<string, Operation<any, any>>>(
  config: WithOperations<T>
): FlatClient<T>

function createGraphQL<
  TQ extends Record<string, Operation<any, any>>,
  TM extends Record<string, Operation<any, any>>
>(config: WithSplit<TQ, TM>): SplitClient<TQ, TM>
```

TypeScript autocomplete works correctly in both modes.

## Execution Loop

Standalone execution loop inside `createGraphQL`, sharing low-level utilities with `createApi` (`composeMiddleware`, `DedupeTracker`, `mergeHeaders`, Result factories) but not wrapping it.

Simpler than `createApi` — no path param substitution, no query/body split decision, no special body type detection.

Steps per call:

1. **Compose middleware:** `[...global, ...per-operation, ...per-call]`
2. **Compute abort signal:** routes through `DedupeTracker` if `operation.config.dedupe` is true
3. **Define `core`:** the innermost fetch layer (see GraphQL Error Handling below)
4. **Merge headers:** global < per-operation < per-call; auto-set `Content-Type: application/json` if not already set
5. **Serialize body:** `JSON.stringify({ query: operation.config.operation, variables })` — field is named `operation` in config but sent as `query` on the wire (GraphQL spec)
6. **Build `MiddlewareContext`:** `{ method: 'POST', url: endpoint, path: endpoint, params: variables, headers, body: serializedBody }`
7. **`composeMiddleware` → run**
8. **Post-execution:** clear dedupe tracker, fire `onError` if final result has an error

The `retry` field on every Result re-enters `execute()` from step 1 — full middleware replay, no shortcuts.

## GraphQL Error Handling

GraphQL errors arrive as HTTP 200 with `{ data: null, errors: [...] }`. The core layer detects these after parsing the response body and maps them to `result.error` — giving consumers the same experience as a REST 4xx/5xx:

```
core fetch steps:
  POST endpoint, body = ctx.request.body (pre-serialized JSON string)
  parse response as JSON
  if response.ok:
    if body.errors?.length → createErrorResult (status: 200, body: errors array)
    else                   → createSuccessResult(body.data)
  else:
    → createErrorResult (status: response.status)
  catch (network error):
    → createNetworkErrorResult (status: 0)
```

The `GraphQLError` type mirrors the GraphQL spec:

```ts
interface GraphQLError {
  message: string
  locations?: Array<{ line: number; column: number }>
  path?: Array<string | number>
  extensions?: Record<string, unknown>
}
```

`onError` fires on all three error types (GraphQL errors, HTTP errors, network errors), consistent with `createApi` behaviour.

## File Layout

```
src/
  graphql.ts    ← NEW: Operation, createGraphQL, gql
  types.ts      ← ADD: OperationConfig, GraphQLError, GraphQLBaseConfig,
                        WithOperations, WithSplit, FlatClient, SplitClient, GraphQLMethod
  index.ts      ← ADD: export { createGraphQL, Operation, gql } from './graphql.js'
                        export type { GraphQLError, OperationConfig } from './types.js'
```

## Tests

`tests/create-graphql.test.ts` covers:

- Flat API (`operations`) — correct method calls and inferred types
- Namespaced API (`queries` + `mutations`) — correct nesting on `client.query` / `client.mutation`
- Only `queries` provided — `client.query` present, no `client.mutation`
- Only `mutations` provided — `client.mutation` present, no `client.query`
- GraphQL errors (HTTP 200 with `{ errors }`) → `result.error` set, `result.data` null
- HTTP errors (4xx/5xx) → `result.error` set
- Network errors → `result.error` set, `result.response` null
- `onError` fires for all three error types
- `onError` does NOT fire when result is successful
- Middleware composition: global → per-operation → per-call order
- `retry()` re-enters full pipeline
- `dedupe` cancels previous in-flight request for same operation
- `gql` tag returns correct string

## README Documentation

`README.md` already has sections for `createApi`, `Request`, middleware, and error handling. The GraphQL additions should slot in as a peer section, not an afterthought.

**New section: "GraphQL Client"** — added after the existing REST client sections, before the middleware section. Should cover:

1. **When to use it** — one sentence: use `createGraphQL` when your backend speaks GraphQL; use `createApi` for REST. Both share the same `Result<T>` shape, middleware, and error model.
2. **Basic usage** — `gql` tag, `Operation` class, `createGraphQL` with `operations`
3. **Queries vs mutations** — show the `queries`/`mutations` split and the namespaced API
4. **Error handling** — note that GraphQL errors (HTTP 200 with `{ errors }`) surface as `result.error`, same as REST errors — no special handling needed
5. **Middleware** — one example showing a global auth middleware applied to `createGraphQL` (identical pattern to `createApi`)

The section should match the existing README's tone: concise examples first, brief explanation after. No new top-level heading style — use the same `##` level as existing sections.

## Consumer Usage Example

```ts
import { createGraphQL, Operation, gql } from '@iremlopsum/apify'

const GET_CATEGORY = gql`
  query GetCategory($id: String!) {
    category(id: $id) { id name status }
  }
`

const UPDATE_CATEGORY = gql`
  mutation UpdateCategory($id: String!, $name: String!) {
    updateCategory(id: $id, name: $name) { id name }
  }
`

// Flat API
const client = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  operations: {
    getCategory: new Operation<{ id: string }, Category>({ operation: GET_CATEGORY }),
    updateCategory: new Operation<{ id: string; name: string }, Category>({ operation: UPDATE_CATEGORY }),
  },
  onError: (error) => console.error(error.status, error.body),
})

client.getCategory({ id: '123' })     // → Promise<Result<Category>>
client.updateCategory({ id: '123', name: 'New Name' })

// Namespaced API
const client2 = createGraphQL({
  endpoint: 'https://api.example.com/graphql',
  queries: {
    getCategory: new Operation<{ id: string }, Category>({ operation: GET_CATEGORY }),
  },
  mutations: {
    updateCategory: new Operation<{ id: string; name: string }, Category>({ operation: UPDATE_CATEGORY }),
  },
})

client2.query.getCategory({ id: '123' })
client2.mutation.updateCategory({ id: '123', name: 'New Name' })
```
