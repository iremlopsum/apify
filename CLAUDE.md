# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@iremlopsum/apify` — runtime-agnostic, type-safe API client built on standard `fetch`. Zero runtime dependencies. Pure ESM, strict TypeScript (ES2020 target, DOM lib). Ships three entry points: the core (`.`), opt-in built-in middleware (`./middleware`), and test helpers (`./testing`, added 2.2.0).

The core entry is **not** REST-only: `src/index.ts` also exports `createGraphQL`, `Operation` and `gql`. There are two clients in this package, and they are **parallel implementations, not layers** — see "The GraphQL client is a second pipeline" below before changing either.

Consumer-facing docs live in `README.md` (extensive — usage, options, philosophy). This file is for codebase navigation, not API reference.

## Commands

```bash
npm run test              # vitest watch mode
npm run test:run          # single run (used by prepublishOnly)
npm run test:integration  # integration tests only, against a local node:http server
npm run typecheck         # tsc --noEmit
npm run build             # tsc → dist/
```

`npm run test` / `test:run` are **not** unit-tests-only — they pick up every `tests/**/*.test.ts`, which includes `tests/integration/`. `npm run test:integration` is the one with a narrower scope: its own config (`vitest.integration.ts`) sets `include: ['tests/integration/**/*.test.ts']`. To run only the unit tests, target the non-integration files explicitly (e.g. `npx vitest run tests/create-api.test.ts`) or exclude `tests/integration` on the command line.

`vitest.config.ts`'s only `exclude` entry beyond vitest's defaults is `**/.worktrees/**`. A git worktree there is a full second checkout, so without it every count doubles (354 tests reported as 708) with nothing failing to give it away. If you add to `exclude`, spread `configDefaults.exclude` — assigning the array outright drops vitest's defaults and starts pulling in `node_modules` and `dist/`.

Run a single test file or a single test by name:

```bash
npx vitest run tests/create-api.test.ts
npx vitest run -t "retries 5xx errors"
```

Tests are excluded from `tsconfig.json` compilation (`exclude: ["tests"]`) but vitest picks them up directly. `tsconfig.json` emits to `dist/` from `src/` only.

Integration tests live in `tests/integration/` and use a separate config (`vitest.integration.ts`). They spin up a real `node:http` server on a random port and exercise the library with real `fetch` — no mocked network. `tests/integration/server.ts` is the server; it exports `startServer()` which returns `{ baseUrl, callCounts: Map<string, number>, close() }`. `callCounts` keys are `"METHOD /pathname"` and let tests assert how many real HTTP requests were made.

## Architecture

The library is organized around a two-phase design that requires reading multiple files to understand. Consumer-facing usage is well covered by README — what follows is the internal picture.

### Two-phase flow: Request → createApi

`Request` (`src/request.ts`) is a **typed config container**. It holds the recipe (method, path, middleware, headers, responseType, dedupe, bodyAs) and **never executes anything**. It exists as a class (not a plain object) so its `<TParams, TResponse>` generics can flow through TS inference to the API methods.

`createApi` (`src/create-api.ts`) is the factory. It accepts a record of `Request` instances and generates a callable method per key. The inference chain:

```
Request<TParams, TResponse>
  → ExtractParams / ExtractResponse conditional types
    → ApiMethod mapped type
      → Api<TRequests> — fully-typed method record
```

`ApiMethod` has a key trick: when `TParams extends Record<string, never>` (no-param endpoint), the `params` argument becomes optional (`api.health()` works as well as `api.health({})`).

### The per-call `execute()` pipeline

`create-api.ts` generates a closure per request; every invocation calls an inner `execute()` function that runs nine steps. The order matters:

1. Compose middleware array: `[...global, ...per-request, ...per-call]`
2. Compute effective `AbortSignal` (dedupe-wrapped if `request.config.dedupe`)
3. Define `core` — innermost layer that calls `fetch` and returns a Result
4. `buildUrl` (path params + optional query string) — but bypasses decomposition for special body types (FormData/Blob/ArrayBuffer/URLSearchParams/string)
5. Merge headers (global < per-request < per-call, via `Headers.set` so later wins)
6. Serialize body (only if `!asQuery`); auto-set `Content-Type` only if caller hasn't set one
7. Build `MiddlewareContext`
8. `composeMiddleware(allMiddleware, core, options.skipMiddleware)` → run
9. `.then` hook: clear dedupe tracker, fire `onError` if final result has an error

Everything is wrapped in a try/catch that catches **synchronous** errors (the common one is `TypeError` from `buildUrl` on nested query-string objects) and turns them into a network-error Result. This is what makes the "never throws" contract airtight.

### `retry()` re-enters `execute()`

Every Result's `retry` field points to the same `execute()` closure — not a cached response, not the core fetch. Calling `retry()` rebuilds URL, re-merges headers, re-composes middleware, and re-runs the whole chain. **This is load-bearing**: auth middleware re-injects tokens, logging fires again, caches get re-consulted. Don't refactor `retry` to short-circuit any of this.

### Middleware onion (`src/middleware.ts`)

`composeMiddleware` implements the standard Koa/Redux onion pattern via recursive `dispatch(i)`. Two non-obvious decisions:

- **No double-call guard.** A middleware can call `next()` multiple times sequentially. This is intentional — `retryMiddleware` relies on it to re-execute the downstream chain on 5xx responses. Don't add a "already called next()" check.
- **Skip is by reference (`===`).** `skipMiddleware: [retryMiddleware(3)]` does **not** work — each factory call produces a new closure. Users must store factory-created middleware in a variable to skip it. The same applies to anything passed to a `skipMiddleware` array.

Layer order is global → per-request → per-call. "Most general to most specific" — global middleware wraps everything, per-call is innermost.

### `onError` fires only on the final result

`onError` is in the `.then` hook **after** the middleware chain completes, not inside `core`. If retry middleware recovers a 5xx to a 200, `onError` does not fire. This is by design — it's the "last chance" hook, not a per-attempt hook. Don't move it inside the chain.

### Dedupe (`src/utils/dedupe.ts`)

A `DedupeTracker` is instantiated **per `createApi` call** (not globally). Different API instances have independent dedupe state. When `request.config.dedupe` is true, `track(name, externalSignal)`:

1. Aborts any existing controller for that `name`
2. Creates a fresh controller
3. Merges the caller's external signal — handling both "already aborted" and "aborts later" cases (uses `{ once: true }` listener to prevent leaks)

`clear(name)` runs inside the post-execution `.then` to remove the Map entry (without aborting — request already finished). Without `clear()`, the Map would grow.

### `ApiError` is not an `Error` subclass

`src/result.ts` defines `ApiError` as a plain class, not `extends Error`. Rationale: it represents an API-level error, not a programming error, so stack traces and error inheritance are not useful. It is exported **as a value** from `src/index.ts` so consumers can `instanceof` check.

Three Result factories correspond to the three outcomes:
- `createSuccessResult` — 2xx, body parsed
- `createErrorResult` — non-2xx, raw `Response` is present
- `createNetworkErrorResult` — fetch threw (or sync error), `response: null`, `error.status === 0`, `error.body` is the native `Error`/`DOMException`

### Types live in one file to avoid circular imports

`src/types.ts` is the single source of truth for every shared type. Without it, `result.ts` and `middleware.ts` would import each other's types and create a cycle. `ApiError` is re-exported as a type from `types.ts` (the class itself lives in `result.ts`); modules that need the actual class import directly from `./result.js`.

### Path param substitution

`src/utils/path-params.ts`'s `buildUrl` uses a regex with lookahead: `:key(?=[^a-zA-Z0-9_]|$)`. This prevents `:id` from matching inside `:idExtra`. Params not matching any `:token` fall through to `remaining`, which is either query-string-serialized (asQuery) or returned for body serialization.

Nested objects in query strings **throw `TypeError`** — the library deliberately refuses to pick a serialization convention (brackets vs dots vs JSON). Don't add nested-object support. Arrays use repeated keys (`tags=a&tags=b`).

### Body serialization dispatch

`src/utils/serialize.ts`'s `serializeBody` auto-detects: `null`/`undefined` → no body, `string` → `text/plain`, `FormData` → pass-through **with `contentType: null`** (the runtime must set the multipart boundary — don't set Content-Type for FormData), `URLSearchParams` → `application/x-www-form-urlencoded`, `Blob`/`ArrayBuffer` → `application/octet-stream`, plain object → `JSON.stringify` + `application/json`.

`create-api.ts` only auto-sets `Content-Type` on the headers if `serializeBody` returned a non-null value **and** no `Content-Type` header is already set (so per-call/per-request headers win).

`Request.shouldSerializeAsQuery` getter encapsulates the rule: `bodyAs` wins; otherwise GET/DELETE → query, everything else → body.

### The GraphQL client is a second pipeline, not a layer

`src/graphql.ts` does **not** call `createApi`. It has its own `execute()`, its own `core`, its own `buildFailedResult`, its own dedupe registration and its own parse path — a near-parallel reimplementation of `create-api.ts` specialised to `POST` + `{ query, variables }`. `createGraphQL`/`Operation`/`gql` ship from the core barrel.

**This is the single most expensive thing to forget in this repo.** A behavioural change made in `create-api.ts` alone silently leaves the two clients disagreeing about the same server response, and that class of divergence has cost multiple review rounds across 3.0.0 and 4.0.0. When you change error classification, parsing, or the Result shape, check whether `graphql.ts` needs the same change — and if it deliberately does *not*, write down why.

`Operation<TVariables, TData>` mirrors `Request<TParams, TResponse>`: a typed config container with phantom fields, executing nothing. GraphQL-specific behaviour worth knowing: an `{ errors }` response on a 2xx is an **error** Result (`kind: 'http'`, `status` the response's own — not hardcoded — with `statusText: 'GraphQL Error'` as the deliberate marker distinguishing a GraphQL error from an HTTP one, since `kind` is `'http'` for both) with any partial result in `error.partialData` rather than on `Result.data`, which keeps the union clean.

### The empty-body contract (4.0.0): two seams, one rule

A success must carry data. Both clients enforce it at exactly one place each:

- `create-api.ts` — `parseResponse` returns the module-private `EMPTY_JSON_BODY` symbol for an empty `json` body (**not** `null`: `JSON.parse("null")` is also `null`, and a server sending the body `null` sent valid JSON). The success path turns that into `kind: 'parse'`; the non-2xx path normalizes it to `null` for `error.body`.
- `graphql.ts` — `gqlBody?.data == null` on the success path, which covers an empty body, `{}`, a literal `{"data": null}` and a non-object JSON root.

Two invariants that are quiet when broken. First, in `graphql.ts` the `errors` branch **must** run before the no-`data` guard, or every GraphQL field error reclassifies from `'http'` to `'parse'`. Second, `error.body` is the raw response text on these paths, not a thrown exception — `''` for REST (its trigger is reachable only when the text is provably empty), the live text for GraphQL (its guard fires on four distinct textual states). Both are pinned by tests; if you "unify" them you will break one.

`responseType: 'none'` is the declared escape for an endpoint that returns no body. Its pairing with `TResponse = undefined` is a **convention, not a compile-time guarantee** — TS1092 forbids type parameters on constructors, so the current `Request` constructor cannot express it. A generic factory could; it is deferred as purely additive.

## File layout (source)

```
src/
  index.ts                  # public barrel — createApi, Request, ApiError,
                            #   createGraphQL, Operation, gql
  create-api.ts             # the REST pipeline (see above)
  graphql.ts                # the GraphQL pipeline — parallel, not layered
  request.ts                # Request class, shouldSerializeAsQuery
  result.ts                 # ApiError + three Result factories
  middleware.ts             # composeMiddleware onion engine
  types.ts                  # single source of truth for all shared types
  built-in-middleware.ts    # retryMiddleware, logMiddleware, cacheMiddleware
                            #   (./middleware entry)
  testing.ts                # mockFetch, jsonResponse, successResult,
                            #   errorResult (./testing entry)
  utils/
    path-params.ts          # joinUrl, buildUrl — path substitution + query
    serialize.ts            # serializeBody — body auto-detection
    headers.ts              # mergeHeaders — the three-layer precedence merge
    special-body.ts         # isSpecialBody, isOpaqueParams
    dedupe.ts               # DedupeTracker — cancel-the-previous
    share.ts                # ShareTracker, ABANDONED — join-the-existing
    any-signal.ts           # anySignal — AbortSignal.any is banned (see below)
    abort-kind.ts           # abortKind, propagatesReason — abort classification
    budget.ts               # resolveBudget — per-call vs per-operation deadline
    timeout.ts              # timeoutSignalFor
    cache.ts                # CacheStore, stableStringify (cacheMiddleware)
```

`src/index.ts` intentionally does **not** export `composeMiddleware`, utils, or Result factories — those are implementation details. If asked to expose something, push back unless there's a concrete consumer need.

**`dedupe` and `share` are opposites**, and a `Request` setting both throws at `createApi` construction — the one sanctioned throw outside a Result, because it is a configuration mistake rather than a request failure. `dedupe` aborts the in-flight call and starts fresh; `share` joins it and hands every caller the same result.

**`AbortSignal.any` is banned** — it is above the supported floor (Node 20.3 / Safari 17.4). `src/utils/any-signal.ts` is the replacement, with a single-signal fast path. Regex lookbehind is banned for the same reason.

## Conventions that will trip you up

- **`.js` extensions in TypeScript imports.** Every internal import writes `from './result.js'` even though the file is `result.ts`. This is standard ESM-in-TS and is required because `"module": "ESNext"` + `"moduleResolution": "bundler"` emits unmodified import specifiers. Tests also use `.js` (e.g., `from '../src/create-api.js'`).
- **`retryMiddleware` only retries 5xx.** Not 4xx, not network errors (status 0). This is intentional — consumers can wrap a custom middleware for network-error retries.
- **`logMiddleware` uses `Date.now()`**, not `performance.now()`, for runtime compatibility (some edge runtimes lack `performance`). Don't "upgrade" it.
- **Unit tests mock `fetch` globally** via `vi.stubGlobal('fetch', mockFetch)` in `beforeEach` with `vi.restoreAllMocks()` in `afterEach`. Each unit test file defines its own `mockJsonResponse` / `mockNetworkError` helpers. Vitest env is `node` (`vitest.config.ts`). Integration tests do the opposite — they never mock fetch; the real fetch hits a real local server.
- **No `tests/` compilation.** Don't import from `tests/` in `src/`, and don't expect `tsc` to build tests — only vitest processes them.
