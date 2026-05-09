# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@iremlopsum/apify` — runtime-agnostic, type-safe API client built on standard `fetch`. Zero runtime dependencies. Pure ESM, strict TypeScript (ES2020 target, DOM lib). Ships two entry points: the core (`.`) and opt-in built-in middleware (`./middleware`).

Consumer-facing docs live in `README.md` (extensive — usage, options, philosophy). This file is for codebase navigation, not API reference.

## Commands

```bash
npm run test              # vitest watch mode (unit tests only)
npm run test:run          # single run (used by prepublishOnly)
npm run test:integration  # integration tests against a local node:http server
npm run typecheck         # tsc --noEmit
npm run build             # tsc → dist/
```

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

## File layout (source)

```
src/
  index.ts                  # public barrel — core exports only
  create-api.ts             # the pipeline (see above)
  request.ts                # Request class, shouldSerializeAsQuery
  result.ts                 # ApiError + three Result factories
  middleware.ts             # composeMiddleware onion engine
  types.ts                  # single source of truth for all shared types
  built-in-middleware.ts    # retryMiddleware, logMiddleware (separate entry)
  utils/
    path-params.ts          # buildUrl — path substitution + query string
    serialize.ts            # serializeBody — body auto-detection
    dedupe.ts               # DedupeTracker
```

`src/index.ts` intentionally does **not** export `composeMiddleware`, utils, or Result factories — those are implementation details. If asked to expose something, push back unless there's a concrete consumer need.

## Conventions that will trip you up

- **`.js` extensions in TypeScript imports.** Every internal import writes `from './result.js'` even though the file is `result.ts`. This is standard ESM-in-TS and is required because `"module": "ESNext"` + `"moduleResolution": "bundler"` emits unmodified import specifiers. Tests also use `.js` (e.g., `from '../src/create-api.js'`).
- **`retryMiddleware` only retries 5xx.** Not 4xx, not network errors (status 0). This is intentional — consumers can wrap a custom middleware for network-error retries.
- **`logMiddleware` uses `Date.now()`**, not `performance.now()`, for runtime compatibility (some edge runtimes lack `performance`). Don't "upgrade" it.
- **Unit tests mock `fetch` globally** via `vi.stubGlobal('fetch', mockFetch)` in `beforeEach` with `vi.restoreAllMocks()` in `afterEach`. Each unit test file defines its own `mockJsonResponse` / `mockNetworkError` helpers. Vitest env is `node` (`vitest.config.ts`). Integration tests do the opposite — they never mock fetch; the real fetch hits a real local server.
- **No `tests/` compilation.** Don't import from `tests/` in `src/`, and don't expect `tsc` to build tests — only vitest processes them.
