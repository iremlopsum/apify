# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] — 2026-09-13

Four new capabilities — a whole-operation `timeout`, a real retry backoff
policy, request coalescing via `share`, and a framework-agnostic testing entry
point — plus an `ApiError.kind` discriminator. Additive for typical consumers,
with two behavioural changes existing callers will notice, called out under
Changed.

### Added

- **`timeout`** on `RequestConfig`, `CallOptions`, and `OperationConfig` — a
  whole-operation deadline, not a per-attempt budget. One signal covers the
  entire middleware chain, including every retry and its backoff delay, so
  `timeout: 5000` combined with `retryMiddleware(3)` still means "an answer
  within 5 seconds" for the call as a whole. This deliberately differs from
  axios, XHR and `got`, which apply a timeout per attempt; the README shows the
  per-attempt recipe (a signal-replacing middleware placed inside the retry
  middleware) for readers who want that instead. `result.retry()` always
  starts a fresh budget. A timeout produces `status: 0`, `kind: 'timeout'`.
  Non-positive or omitted disables it.
- **A real retry backoff policy.** `retryMiddleware` now accepts
  `number | RetryOptions`: `max`, `delay` (`'exponential' | 'linear'` or a
  custom function), `baseDelay`, `maxDelay`, `jitter` (full jitter, default
  on), `respectRetryAfter` (honours a `Retry-After` response header, default
  on), `retryOn` (default: retry 5xx only — 429 and network errors are
  opt-in), and an observational `onRetry` hook. `retryMiddleware(3)` keeps
  working exactly as before, as shorthand for `{ max: 3 }`.
- **`share: true`** on `RequestConfig` — coalesces identical concurrent calls
  onto a single in-flight request. Sibling of `dedupe`, with the opposite
  intent: dedupe cancels the older call, share joins the existing one. Setting
  both on the same `Request` throws at `createApi(...)` time. A per-call
  `signal` or `timeout` bounds only that caller, via a refcount, and never the
  shared request itself; a per-call `headers` or `middleware`, or params that
  are a special body type (`FormData`, `Blob`, `ArrayBuffer`,
  `URLSearchParams`, a raw `string`), always get their own unshared request.
- **`@iremlopsum/apify/testing`** — a new, framework-agnostic entry point with
  no test-runner dependency: `mockFetch` (a route-matching `fetch` stub keyed
  by `"METHOD /path"`, with `:token` capture, call recording, and response
  sequencing), `jsonResponse`, `successResult`, and `errorResult`.
- **`ApiError.kind`** — an optional discriminator:
  `'http' | 'network' | 'abort' | 'timeout' | 'parse'`. Branch on this instead
  of `status` to tell a timeout, a cancellation, and a genuine network failure
  apart — all three carry `status: 0`. `'parse'` is reserved for a future
  release and is not produced by this one.

### Fixed

- **A non-integer or oversized `timeout` no longer breaks the request.**
  `AbortSignal.timeout()` accepts only an integer in `[0, 2^31 - 1]`, so a
  perfectly ordinary `budget / 3` or `Number(process.env.TIMEOUT)` threw a
  `RangeError` during setup — the request was never sent, and the caller got a
  `kind: 'network'` Result indistinguishable from being offline. Values are now
  rounded down to whole milliseconds and clamped to the timer ceiling; `NaN`
  and non-positive values still mean "no timeout". Applies to `createGraphQL`
  too, which shares the helper.
- **`share: true` returns a `Result` from every exit.** The coalescing block
  ran outside the request pipeline's `try`/`catch`, so a throw in it escaped as
  a rejection; and a rejection from the shared operation was handed back *as
  if it were a `Result`*, leaving `data` and `error` both `undefined` so
  `if (error)` was false and the call looked like a success with no data. Both
  now produce a proper network-error `Result`.
- **A throwing `onError` no longer rejects the caller.** `onError` fires after
  the `Result` is in hand, so a misconfigured error reporter — or a logger
  reaching for `error.response.status` where `response` is `null` — rejected a
  promise that already held a perfectly good `Result`. It is now guarded on
  both `createApi` and `createGraphQL`, matching the retry policy's `retryOn`,
  `onRetry` and custom `delay` callbacks.
- **Under `share`, `RequestConfig.timeout` now bounds the shared request.** It
  was applied per-caller, from each caller's join time, so a steady arrival of
  joiners could hold one socket open indefinitely against the configured
  deadline. The operation's deadline now bounds the one real request for
  everyone, measured from when that request started; `CallOptions.timeout`
  still bounds only the caller that passed it, which means a per-call
  `timeout: 0` cannot lift the operation's own deadline.
- **A sharer's own timeout or abort now reaches `onError`**, as the identical
  non-shared call always did.
- **`headers: {}` or `middleware: []` no longer disables coalescing.** The gate
  tested truthiness rather than emptiness.
- **`cacheMiddleware` no longer collapses special-body params to one key.**
  `FormData`, `Blob`, `ArrayBuffer` and `URLSearchParams` all stringify to
  `"{}"` for keying purposes, so two different uploads through one cache served
  each other's responses. Such calls are now neither cached nor served from
  cache — the same stance `share` takes. Pre-existing (not new in 2.2.0), fixed
  here because this release introduces the guard for the identical bug under
  `share`.
- **A custom retry `delay` curve returning `NaN` or a negative no longer
  reaches `setTimeout`**, where both mean "retry immediately" and turn a
  backoff policy into a tight loop. A non-finite result falls back to the
  exponential default; a negative is clamped to zero.
- **`mockFetch` rejects a route key with no method** (`'/users'`) at
  construction, instead of registering a route that can never match.

### Changed

- **Retries now back off instead of firing instantly.** Before this release,
  `retryMiddleware(3)` made all four attempts in the same tick, with no delay
  between them. It now waits out a real backoff (exponential by default, with
  full jitter) between attempts, honouring a `Retry-After` response header
  when the server sends one. Tests or timing assumptions that depended on the
  old zero-delay retries will need `baseDelay: 0` (and `jitter: false`, and
  possibly fake timers) to stay fast and deterministic.
- **Abort reasons now propagate through `dedupe`.** This is worth reading even
  if you never touch the new `kind` field: `error.body` — the native
  `Error`/`DOMException` the library has always put there for a network
  error or abort — and its `.name` are a **pre-2.2.0 surface** that existing
  consumers can already be reading. Previously, a `dedupe: true` request's
  merged signal always aborted with a generic, reason-less `AbortError`,
  discarding whatever reason the external signal actually carried (a
  `TimeoutError` from a timeout-setting middleware, or a custom reason passed
  to your own `AbortController.abort(reason)`). The merged signal now
  preserves that original reason, so code reading `error.body.name` under
  `dedupe: true` combined with a signal-setting middleware can see a different
  value after upgrading — independent of whether it adopts `kind` at all.

## [2.1.0] — 2026-09-13

Six audit fixes plus a package-size reduction. Non-breaking for consumers, with
one exception called out under Removed: the supported Node floor moves to 20.

### Added

- `ctx.request.signal` on `MiddlewareContext` — middleware can now read the
  `AbortSignal` handed to `fetch`, or replace it to impose its own cancellation
  policy. A timeout middleware is four lines; see the README. Under
  `dedupe: true` a replacement is merged into the dedupe signal rather than
  discarded, so the request is cancelled by whichever fires first.
- `engines: { node: ">=20" }` in `package.json`, so the support floor is visible
  to package managers rather than only to README readers.
- CI workflow — typecheck, unit tests, integration tests and build on push and
  pull request, across Node 20, 22 and 24. Runs with a read-only token and
  cancels superseded runs for the same ref.

### Fixed

- **Dedupe no longer cancels the wrong request.** `clear()` deletes the map
  entry only when it still owns it; previously a superseded request settling
  late deleted the entry belonging to whichever newer request replaced it,
  silently disabling dedupe from the second cancellation onward.
- **A cache hit no longer aborts a live request.** Dedupe registration moved
  inside the core fetch, so a middleware that short-circuits above it never
  registers — and so never cancels a request that is genuinely in flight.
- **An older request's retry no longer aborts a newer call.** Registration
  happens once per call rather than once per attempt, which keeps
  `retryMiddleware` composed with `dedupe: true` from inverting dedupe's
  newest-wins contract.
- **A missing path param is now an error, not a malformed request.** An
  unresolved `:token` used to ship literally in the URL *and* duplicate its
  value as a query param. It now surfaces as a network-error `Result` naming
  the offending token.
- **Repeated path tokens substitute.** `/orgs/:id/members/:id` fills both
  occurrences; previously only the first was replaced.
- **`baseUrl` and `path` join with exactly one slash.** A trailing slash on
  `baseUrl` — the shape `process.env.API_URL` usually has — produced `//`,
  which some servers 404 on and which can trigger a cross-origin redirect that
  drops the `Authorization` header. The synchronous error path reports the same
  normalised URL.
- Unresolved-token detection no longer uses a regex lookbehind. An unsupported
  regex literal is a parse-time `SyntaxError` that takes down the whole module,
  which is the wrong failure mode for a library that advertises being
  runtime-agnostic.

### Changed

- **Package size roughly halved** — 241 kB → 113 kB unpacked, 65 kB → 32 kB
  packed. JS and declaration emit are split into two `tsc` passes, so comments
  are stripped from the shipped `.js` while JSDoc survives intact in the `.d.ts`
  and editor hovers are unaffected. Broken source maps — they referenced
  `../src/*.ts`, which is not published — are no longer emitted. Runtime cost is
  unchanged: about 2 kB gzipped for a REST-only import.
- `sideEffects: false` declared, so webpack and Rollup tree-shake as
  aggressively as esbuild already did.
- `build` cleans `dist/` first. Without it, building over a `dist/` from an
  earlier version would publish stale source maps and orphaned modules.
- `MiddlewareContext['request'].signal` is optional (`signal?: AbortSignal`), so
  consumers constructing a context by hand to unit-test their own middleware are
  not forced to supply it.

### Removed

- **Node 18 support.** The package now requires Node 20 or newer. Node 18 went
  end-of-life in April 2025; CI tests 20, 22 and 24.
- Dead `eslint-disable` comments for a linter that is not installed.

## [2.0.0] — 2026-05-09

### Added

#### GraphQL client

- New `createGraphQL` factory with flat and split APIs — mirrors REST `createApi` DX with the same middleware pipeline, `onError`, `retry()`, and dedupe support
- `Operation<TVariables, TData>` class for typed GraphQL operations — parallel to `Request` for REST
- `gql` template-literal tag for syntax highlighting and no-op passthrough
- `GraphQLError` type, `GraphQLResponse<T>` wrapper, and full GraphQL types in `types.ts`
- All GraphQL exports (`createGraphQL`, `Operation`, `gql`) available from the core entry point (`.`)

#### Cache middleware

- New `cacheMiddleware` built-in — response caching with configurable TTL, LRU/LFU eviction, `clear()`, and optional debug logging
- `CacheStore` utility with `stableStringify` for deterministic cache-key generation; handles key escaping and `null`/`undefined` distinction correctly
- `CacheMiddleware` type exported from `./middleware` entry point
- Documented in README under Built-in Middleware

### Changed

- `mergeHeaders` extracted to a shared utility (`src/utils/headers.ts`) — used by both REST and GraphQL pipelines
- README substantially expanded: new introduction, full table of contents, GraphQL client section, cache middleware section; clarified that GraphQL shares all REST DX features

### Fixed

- `stableStringify` key escaping and `null`/`undefined` handling corrected
- `Operation` type strengthened with phantom generics to preserve `TVariables`/`TData` through inference
- `GraphQLError` type used consistently for the `errors` array; `SplitClient` uses proper `{}` constraint
- `CacheMiddleware` type export was missing — added
- Spurious `eslint-disable` comment removed from `headers.ts`
- Final review issues addressed across GraphQL implementation

### Tests

- Integration test suite added (`tests/integration/`) — exercises the full library against a real `node:http` server with no mocked network:
  - REST core: success, error, network error, path params, query strings, body serialization, response types
  - REST middleware: `logMiddleware`, `retryMiddleware`, `skipMiddleware`, `onError`, `retry()`, dedupe
  - GraphQL: flat and split clients, error responses, middleware, real HTTP round-trip assertions via `callCounts`
- `vitest.integration.ts` config and `@types/node@^22` dependency added
- `tests/integration/server.ts` exports `startServer()` returning `{ baseUrl, callCounts, close() }` for precise per-request assertion

### Internal

- `@types/node` pinned to `^22` to match the Node 22 runtime target

## [1.0.0] — 2026-04-01

Initial release of the rewritten client. Reconstructed from the release commit
(`e996cf3`), which predates per-feature changelog entries.

### Added

- `createApi` — factory turning a record of `Request` definitions into a typed,
  callable API object, with per-call options for middleware, headers and signals
- `Request` — typed endpoint definition carrying method, path template,
  middleware, headers, response type and body-serialisation strategy
- `Result<T>` — `{ data, error, response, retry }` returned by every call; the
  library never throws
- `ApiError` — structured error with status, body, headers and request metadata.
  Deliberately not an `Error` subclass
- Middleware onion (`composeMiddleware`) with three layers — global,
  per-request, per-call — plus `skipMiddleware` for per-call opt-out
- Built-in `retryMiddleware` (5xx only) and `logMiddleware`, on the
  `./middleware` entry point
- Request deduplication (`dedupe: true`), auto-cancelling a previous in-flight
  call to the same endpoint
- Path parameter substitution and query-string building
- Body serialisation for JSON, `FormData`, `URLSearchParams`, `Blob`,
  `ArrayBuffer` and strings
- Response parsing as `json`, `text`, `blob`, `arrayBuffer` or `formData`

[2.2.0]: https://github.com/iremlopsum/apify/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/iremlopsum/apify/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/iremlopsum/apify/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/iremlopsum/apify/releases/tag/v1.0.0
