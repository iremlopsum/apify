# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.4.0] — 2026-09-19

### Added

- **A fragment in a `defineRequest` path literal is now a compile error.**
  4.2.1 made the runtime refuse a `#` in a `path` or `baseUrl`, because `fetch`
  never transmits a fragment. That left the type accepting what the runtime
  rejects — `defineRequest()({ path: '/docs#section' })` compiled, and the
  endpoint then failed on every call.

  ```ts
  defineRequest<Doc>()({ method: 'GET', path: '/docs#section' })
  //                                          ^ Property '__fragmentInPath' is missing:
  //                                            a URL fragment is never sent to the server
  ```

  The guard **fires only on a literal**. A path assembled at runtime, a
  `RequestConfig`-typed variable, and a spread of one all still compile and are
  caught by the runtime error instead — the same permissiveness constraint that
  sank the 3.1.0 `responseType: 'none'` guard attempt. `new Request` has no
  equivalent check because it takes no path literal.

  **This can turn a previously-compiling build red.** See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-440) — the rejected code was
  already failing at runtime on every call.

### Fixed

- **`joinUrl` composes a URL fragment structurally, like it already does the
  query string.** `buildUrl` refuses a fragment, which sends `urlForError` down
  its `joinUrl` fallback — and that fallback still concatenated, leaving the
  base's fragment mid-string. `'https://api.test/v1#f'` joined to `'/items'`
  produced `'.../v1#f/items'`, which parses to pathname `/v1`: the reported URL
  named an endpoint the call was never for. It now produces
  `'https://api.test/v1/items#f'`.

  Diagnostic only — `error.request.url`, never a URL that reaches the network,
  since the request is refused either way. But it is the same class of mangled
  output 4.2.1 removed from the request path, and a report that resolves
  somewhere else is worse than no report.

  The fragment splits **before** the query, and the two are not interchangeable:
  RFC 3986 orders a URL `path?query#fragment`, so a `?` after a `#` belongs to
  the fragment. Splitting the query first read `#f?x=1` as a query string that
  is not one and re-emitted it as a real one.

### Known gap

- For a path template **with params**, `error.request.url` on the fragment
  failure still reports the raw `:id` template rather than the substituted
  value, because `buildUrl` throws before substitution runs. Pinned by a test.
  Closing it means letting the fragment check run after substitution, which
  changes `buildUrl`'s shape rather than `joinUrl`'s.

## [4.3.0] — 2026-09-19

### Added

- **`paginate()` — walk a paginated endpoint as an async iterator.** Yields one
  `Result` per page, so the shape is the same one every other entry point
  returns.

  ```ts
  for await (const page of paginate(api.listItems, { limit: 50 }, {
    next: (p, prev) => p.data.cursor ? { ...prev, cursor: p.data.cursor } : undefined,
  })) {
    if (page.error) break
    render(page.data.items)
  }
  ```

  `next` returns the **next params**, not a cursor. Returning a cursor would
  leave this library deciding where to put it — `cursor`, `page_token`,
  `after` — and a config option per API in existence is the outcome
  `buildUrl`'s refusal to guess a nested-query-string format already rejected.
  The previous params arrive as the second argument, so cursor, offset and
  `Link`-header paging are all the same spread.

  An error page is yielded and ends the walk: there is no data to read the next
  cursor from. `maxPages` is available and has no default, because a silent
  truncation at an invented ceiling is indistinguishable from reaching the last
  page. Any `CallOptions` apply to every request, so one signal cancels the
  crawl.

  A `next` that throws propagates to the caller rather than becoming a
  `Result` — it runs inside their own `for await`, and a `Result` would need an
  error kind that fits nothing while hiding the stack that identifies the bug.

  Standalone, not a method on generated endpoints: `createApi` and its types are
  unchanged, and the import costs nothing to anyone who does not use it.

## [4.2.1] — 2026-09-19

Two URL-composition fixes. Both produced strings that looked plausible and
resolved to the wrong request, so neither was visible without inspecting what
the network layer actually parsed.

### Fixed

- **A `baseUrl` carrying a query string no longer swallows the path.**
  `baseUrl: 'https://api.test/v1?key=abc'` with `path: '/items'` built
  `https://api.test/v1?key=abc/items` — which resolves to path `/v1`, so the
  request went to a different endpoint entirely, silently. The path is now
  joined onto the base path and the query strings are merged, base params first:
  `https://api.test/v1/items?key=abc&page=2`.

- **A URL fragment in a `path` or `baseUrl` is now refused.** A fragment is
  never transmitted, so one in a request URL could not do what it appeared to —
  and it silently discarded the query string: `'/docs#section'` with
  `{ page: 2 }` built `'/docs#section?page=2'`, which the network layer reads as
  path `/docs` with no query at all. `page=2` never left the client.

  It is refused rather than stripped, because stripping hides the mistake and
  leaves a line of code that does nothing. The failure is a `Result`, not a
  throw. See [MIGRATION.md](./MIGRATION.md) — this is the one change that needs
  action, and only if a `#` appears in one of your templates.

## [4.2.0] — 2026-09-18

### Added

- **Optional response validation against a Standard Schema validator.** Pass
  `schema` on a request or a GraphQL operation and the successful response is
  validated before it reaches you. Zod, Valibot and ArkType all implement the
  interface; apify takes no dependency on any of them, because Standard Schema
  is an interface rather than a package.

  On the REST side the schema also **supplies the response type**, so
  `defineRequest()({ method, path, schema })` needs no type argument at all —
  which is what the curried factory added in 4.1.0 was for. Passing both a
  schema and an explicit response type is a compile error, even when the two
  agree: the failure that guards against is the schema changing later while the
  explicit type quietly does not.

  `data` is the schema's **output**, so transforms, coercions and defaults
  apply — `z.coerce.date()` gives you a `Date`. This means `data` is no longer
  byte-identical to the response body when a schema transforms.

  A refusal is a `kind: 'parse'` error with the validator's issues in
  `error.body` and the response's own status, matching every other parse error:
  the server answered, we could not accept the answer. A validator that throws
  rather than returning issues is reported the same way.

  Only the success body is validated; a non-2xx body is left alone. On the
  GraphQL client the response type stays explicit — only `defineRequest` infers.

## [4.1.1] — 2026-09-18

### Fixed

- **`defineRequest` now infers a path parameter that starts the path.** A `path`
  of `':id'` or `':id/foo'` — the token at the very start of the string —
  inferred no parameters at all, while the request still required one and failed
  at runtime with `Unresolved path parameter :id`.

  4.1.0 anchored the type-level parser to a preceding `/`, mirroring the rule
  that stops a colon *inside* a segment (`/v1/documents:batchGet`, `/events/at/12:30`)
  being read as a parameter. But the runtime anchors to the start of each
  `/`-separated segment, and the first segment begins at the start of the string
  whether or not a slash precedes it — so a leading token was a parameter to the
  request and not to the type.

  A missing leading slash is now normalised before anchoring, making the type's
  rule exactly equivalent to the runtime's. Paths that begin with `/` — every one
  in this project's documentation and tests — are unaffected, as is a path like
  `'users/:id'`, whose token was already preceded by a slash.

## [4.1.0] — 2026-09-18

### Added

- **`defineRequest()` — path parameters are now inferred from the `path`
  literal.** `defineRequest<User>()({ method: 'GET', path: '/users/:id' })`
  produces an endpoint whose params are `{ id: string | number }`, so calling it
  with the wrong key is a compile error instead of a runtime throw from
  `buildUrl`. Params the path does not name go in a second type argument:
  `defineRequest<Repo[], { page?: number }>()`.

  The two calls are load-bearing. TypeScript has no partial type-argument
  inference, so if the response type and the config were arguments to one call,
  supplying the response type explicitly would stop the path from being inferred,
  and the checking would quietly do nothing. Splitting them keeps the response
  type explicit and the path inferred.

  It also enforces `responseType: 'none'`, which `new Request` could only
  document — a guard attempted in 3.1.0 and dropped, because an overload pair
  falls through to the general signature and so rejects nothing.

  Purely additive. `new Request(...)` is unchanged and not deprecated, and
  `createApi` is untouched — `defineRequest` returns an ordinary `Request`.

### Fixed

- **Query params are appended with `&` when the URL already carries a query
  string.** A `path` template with its own query string — `'/search/:q?x=1'` —
  previously produced a second `?`: `/search/hi?x=1?page=2`. Path substitution
  was always correct; only the append assumed no `?` was present yet.

  A `baseUrl` carrying a query string is a separate and wider problem in
  `joinUrl`, which appends the path *after* the query, and is not addressed
  here.

## [4.0.2] — 2026-09-17

One fix, completing 4.0.1's work. No public API change, and no behavioural
change to any successful call.

### Fixed

- **`error.request.url` now reports the resolved, path-substituted URL on every
  error path that can name one.** Three paths previously carried the raw route
  template (`/users/:id`): a `share: true` caller giving up, `execute()`'s
  setup-error catch, and the share path's own setup catch. Grouping telemetry
  by that field produced two shapes for the same endpoint. 4.0.1 fixed the
  `'middleware'` paths; this completes the set.

  **Ordinary aborts were already correct** and are unchanged — a caller
  cancelling mid-flight, a dedupe supersede, and a middleware rethrowing the
  signal reason are all reclassified from the signal that cancelled them, and
  none of them reaches the default this release changes.

  The template still appears in the one case where it is the only honest
  answer: `buildUrl` itself threw, so no URL was ever resolved. An unresolved
  `:token` and a nested object reaching a query string both land there.

  Consumers asserting on the template string in their own tests will see a
  change. The value was wrong, and this is the same class of correction 4.0.1
  shipped as a patch.

## [4.0.1] — 2026-09-16

Three consistency fixes. No behavioural change to any successful call, and no
public API change — each fix replaces a wrong value with the right one.

### Fixed

- **`error.request.url` now reports the path-substituted URL on `'middleware'`
  failures.** It previously carried the raw route template (`/users/:id`) on
  that path while every other error path — `'http'`, `'parse'`, and network
  errors — reported the real address, so grouping telemetry by that field
  produced two shapes for the same endpoint. It remains the template for a
  `share: true` caller giving up — the only give-up path that reaches this
  code — and on the setup-error path: the resolved URL is built inside
  `execute()`, and both of those sites run in the outer closure, where it
  isn't in scope. Ordinary aborts — a caller cancelling mid-flight, a
  dedupe supersede — already reported the resolved URL, and still do.
- **A GraphQL `{ errors }` response now reports the response's own status.**
  It previously hardcoded `200`, so a GraphQL error arriving on any other 2xx
  reported a status the server never sent. `statusText` deliberately remains
  `'GraphQL Error'` — with `kind` reporting `'http'` for both GraphQL and HTTP
  failures, it is the only thing distinguishing them.

### Internal

- Coverage for a GraphQL response carrying an empty `errors` array, which
  falls past the errors branch into 4.0.0's no-data rule and reports `'parse'`.
  Correct since 4.0.0; previously unpinned.
- Two stale comments corrected to match behaviour already fixed: `syntheticResult`'s
  doc in `create-api.ts` (wrongly claimed `'middleware'` results still get the
  route template) and `GraphQLBaseConfig.onError`'s doc in `types.ts` (wrongly
  claimed GraphQL errors arrive only on HTTP 200). No behaviour changed.

## [4.0.0] — 2026-09-16

One rule: a success must carry data. Both clients now report a 2xx response
that carries none as a `kind: 'parse'` error rather than resolving with
`data: null`. See [MIGRATION.md](./MIGRATION.md#upgrading-to-400) — if you
declared `responseType: 'none'` on the endpoints 3.1.0's warning named, this
release is a no-op for you.

### Changed

- **BREAKING: an empty body under `responseType: 'json'` is a `kind: 'parse'`
  error.** Previously it resolved as a success with `data: null`, at every
  status including `204`. The error carries the response's own status (a `204`
  reports `204`, not `0`), keeps the `Response`, and puts the raw body text —
  `''` — in `error.body`. This is what makes `SuccessResult.data: TResponse`
  true rather than documented-as-false: 3.0.0 removed the `| null` that had
  been forcing consumers to check, so `data.deleted` against a `204` compiled
  clean and threw at runtime. Declare `responseType: 'none'` (available since
  3.1.0) on endpoints that answer with no body. There is no `204` special
  case, and a literal `null` body — valid JSON — still succeeds.
- **BREAKING: a GraphQL 2xx response carrying neither `data` nor `errors` is a
  `kind: 'parse'` error.** Covers an empty body, `{}`, a literal
  `{"data": null}`, and a non-object JSON root. `error.body` is the raw
  response text. GraphQL *errors* are unchanged: `{"data": null, "errors":
  [...]}` still reports `kind: 'http'`, with any partial result in
  `partialData`, since that branch runs first and is the spec-compliant shape
  for a field error.

### Removed

- **The one-time empty-body `console.warn` from 3.1.0.** Its success condition
  no longer exists. `responseType: 'none'`, which it pointed at, is permanent.

### Unchanged

- **Non-2xx responses.** Both clients still read and parse an error body for
  `error.body`, on `'none'` as on `'json'`, and an empty error body is still a
  `'http'` error — not a `'parse'` one. 4.0.0 changes what a *success* means
  and nothing else.
- **Public types.** `ResponseType` already had `'none'` and `ApiErrorKind`
  already had `'parse'`; no type was added, removed, or changed.

## [3.1.0] — 2026-09-16

Additive: a `responseType` for endpoints that answer with no body, and a
diagnostic warning for the empty-body gap it closes. No existing behaviour
changes; see [MIGRATION.md](./MIGRATION.md#upgrading-to-310).

### Added

- **`responseType: 'none'`** — declares that an endpoint returns no body on
  success. `data` is `undefined`, no body is read, and any body a successful
  (2xx) response sends anyway is discarded (its stream is cancelled, so a
  keep-alive connection is released). This is the accurate declaration for a
  `204` endpoint, most commonly a `DELETE`. Declare `TResponse` as
  `undefined` alongside it — but this is a convention, not a compile-time
  guarantee: `new Request<P, User>({ responseType: 'none' })` compiles
  clean, since TypeScript cannot infer a literal `responseType` on the
  current non-generic constructor to enforce the pairing.
  Compile-time enforcement is not shipped; 4.0.0 did not add it either, since
  a generic factory would be purely additive and needs no major-version gate.
  A non-2xx response is unaffected: its body is
  still read and parsed as JSON for `error.body`, since `'none'` describes
  the success shape only and an error body remains diagnostic. See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-310).
- **A one-time warning when a `'json'` request receives an empty body.** The
  call still resolves as a success with `data: null`, unchanged from every
  prior release — only a `console.warn` is new, fired once per request name
  per `createApi` instance, naming the request and pointing at
  `responseType: 'none'` as the fix. This is transitional: 4.0.0 turns the
  same case into a `kind: 'parse'` error, and declaring `'none'` now makes
  that upgrade a no-op.

### Internal

- **Test coverage added for the shared-signal re-merge under `share: true`
  combined with signal-replacing middleware.** The behaviour — a middleware
  that installs its own `ctx.request.signal` still has that signal re-merged
  with the share refcount controller — shipped in 3.0.0; this release adds
  the test that pins it, not a behaviour change.

## [3.0.0] — 2026-09-16

Tightens contracts the types always implied but never enforced — a
discriminated `Result`, non-interchangeable `Request` generics, a required
`ApiError.kind` — plus corrected error classification for parse failures and
aborts, and preserved GraphQL partial data. Nine breaking changes; see
[MIGRATION.md](./MIGRATION.md#upgrading-to-300) for upgrade instructions and
worked before/after examples for every one of them.

### Added

- **`ApiError.partialData`** — GraphQL partial-success data (a nullable field
  errored while the rest of the query resolved) is preserved instead of
  discarded. It lives on `error.partialData`, not `Result.data`, so the
  `Result` union's narrowing (see Changed) stays intact: a non-null `error`
  means `data` is null, and a null `error` means the call succeeded (see
  MIGRATION.md's empty-body caveat for the one case where `data` is null
  too).
- **`SuccessResult<T>` and `ErrorResult<T>`** exported as types — the two
  branches of the `Result<T>` union.

### Changed

- **BREAKING: `Result<T>` is now a discriminated union**,
  `SuccessResult<TResponse> | ErrorResult<TResponse>`, not an interface with
  independently-nullable fields. `if (error) return` now narrows `data` to
  `TResponse` — `data` was never actually narrowed before, so the README's own
  headline example (`console.log(data.name)` with no assertion, right after
  checking `error`) has **not** compiled since 2.0.0 without a `data!`
  assertion or a redundant null check at every call site. Middleware that
  synthesises a success `Result` must supply a non-null `Response`. See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: `Request<TParams, TResponse>` generics are no longer
  interchangeable.** Phantom fields make the class's own generics
  load-bearing, so `Request<{ id }, User>` no longer silently accepts a
  `Request<{ slug }, Post>` wherever one is expected. Code relying on the old
  (always-incorrect) assignability now fails to compile. See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: `ApiError.kind` is required, and `ApiErrorKind` gained
  `'middleware'`.** Every construction site inside the library already set
  it; this tightens the type to match. Custom middleware constructing an
  `ApiError` must now supply `kind`, and an exhaustive `switch (error.kind)`
  needs a new arm. See [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: A 2xx response with an unparseable body now reports the real
  `status`, a non-null `response`, and `kind: 'parse'`** — previously
  `status: 0`, `response: null`, `kind: 'network'`, indistinguishable from
  being offline. Non-2xx responses are unaffected: `!response.ok` is checked
  before the body is parsed, so a 5xx with an unparseable body still reports
  `kind: 'http'`, and `retryMiddleware`'s default 5xx retry behaviour has not
  changed. See [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: A throwing middleware now returns a `Result` with
  `kind: 'middleware'` instead of rejecting.** `composeMiddleware` has no
  guard against a middleware throwing, so this broke the library's
  "never throws" contract on the one path most likely to have a bug — your
  own middleware. A `try`/`catch` placed around an API call to catch this can
  be deleted. See [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: `onError` no longer fires for `error.kind === 'abort'`.** A
  cancellation the library caused deliberately — your own `AbortSignal`
  firing, or a `dedupe` supersede — is no longer reported as an error;
  `'timeout'` still fires, since a missed deadline is a genuine failure.
  Hand-rolled `AbortError` filtering in an `onError` handler can be deleted.
  See [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: Aborts are classified by signal provenance, not by the thrown
  reason's name.** A caller's custom abort reason
  (`controller.abort(new Error(...))`, or a string) is now `kind: 'abort'`
  instead of `'network'`, and so is silent instead of reported. A middleware
  propagating the library's own abort reason — verbatim, or wrapped one level
  as `.cause` (the shape `node:timers/promises` and most abortable helpers
  produce) — is now `'abort'`/`'timeout'` and silent, instead of
  `'middleware'` and reported. A middleware throwing its own, unrelated
  `AbortError`-named failure now correctly reports as `'middleware'`, instead
  of being silently swallowed as `'abort'`. See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-300).
- **BREAKING: Cancelling during the response body download — for both 2xx
  and non-2xx responses — is now classified as the cancellation**
  (`kind: 'abort'`/`'timeout'`, `status: 0`, `response: null`), not by
  whichever HTTP stage it happened to interrupt (previously `kind: 'parse'`/
  `status: 200` for a 2xx, or `kind: 'http'`/the real status/`body: null` for
  a non-2xx — both reported). `retryMiddleware`'s default `retryOn` (and any
  custom `status >= 500` predicate) no longer retries a cancellation caught
  in this window, since `status` is now `0` — strictly correct, but
  observably fewer requests. See
  [MIGRATION.md](./MIGRATION.md#upgrading-to-300).

### Fixed

- **Abort/timeout classification no longer hangs or crashes on a hostile
  abort reason.** A caller-supplied `signal.reason` (or a value a middleware
  throws) is arbitrary — a revoked `Proxy`, a reactive-framework wrapper, or
  a class with a lazy `get name()`/`get cause()` can throw on property
  access. Reading `.name` (to detect `AbortError`/`TimeoutError`) or `.cause`
  (to detect a wrapped propagated reason) is now guarded; a throwing getter
  is treated as "doesn't match" instead of escaping the last-resort handler
  that exists specifically to keep the library's "never throws" contract
  intact. Previously this could leave a `share: true` caller's promise
  permanently pending, or reject an unshared call outright.
- **A shared (`share: true`) request whose signal a middleware replaces is
  still cancelled when every sharer gives up.** A middleware that installs
  its own `ctx.request.signal` (a deadline, a circuit breaker) used to drop
  the shared refcounted signal entirely — every sharer releasing no longer
  aborted the real request, so the socket stayed open with nobody waiting on
  it, and with `retryMiddleware` it kept retrying in the background after
  every caller had already resolved. The shared signal is now re-merged in
  whenever a middleware replaces it, the same way dedupe's registration
  already had to.
- **`result.retry()` no longer rejects when called with an unexpected call
  shape.** `retry` is handed out directly as a plain function, so
  `arr.map(result.retry)` (which passes the array index as a second
  argument) or `result.retry(undefined, 0)` threw a `TypeError` out of the
  one path that must always produce a `Result`. All call shapes now return a
  `Result`.
- **A shared (`share: true`) call no longer re-reports a give-up that lands
  after the operation has already settled.** The realistic trigger is a
  consumer's `onError` handler reacting to a shared failure by aborting
  another of its own still-outstanding callers with a hand-crafted
  `TimeoutError`-shaped reason (`ac.abort(new DOMException('t',
  'TimeoutError'))`) — to give up on the rest of a batch, say. That caller's
  own give-up listener was technically still armed even though the operation
  already had its `Result`, and would otherwise report a second, misleading
  failure for an operation that already reported once. (A plain
  `AbortError`-shaped give-up doesn't need this fix to avoid a double report —
  `onError` never fires for `error.kind === 'abort'` at all — so the fix
  matters specifically for a give-up whose reason survives that filter.)

## [2.2.1] — 2026-09-14

Five fixes closing findings that were identified and deliberately parked
during 2.2.0's final review (see "Known, recorded, not fixed" in that
release's notes). No public API change.

### Fixed

- **`cacheMiddleware` no longer skips caching string-param endpoints — a
  behavioural regression introduced by 2.2.0.** The special-body guard added
  that release (for the pre-existing `FormData`/`Blob`/`ArrayBuffer`/
  `URLSearchParams` cache-key collapse) reused `isSpecialBody`, which also
  excludes a raw `string`. But `stableStringify` keys a string correctly —
  unlike those four object types, which all collapse to the literal `"{}"` —
  so excluding it was never necessary and silently stopped caching any
  string-param endpoint. **If your string-param endpoints stopped being
  cached after upgrading to 2.2.0, this restores it.** A new predicate,
  `isOpaqueParams`, narrows the guard to the object types whose own
  enumerable keys don't distinguish two different instances, and is used by
  both `cacheMiddleware` and `share`'s coalescing gate; a string-param
  endpoint under `share: true` is now soundly coalesced too. `isSpecialBody`
  itself is unchanged and still used for body serialization, where a raw
  string legitimately needs the same treatment. **`isOpaqueParams` also now
  recognises `Date`, `Map`, and `Set`** (in addition to `FormData`, `Blob`,
  `ArrayBuffer`, `URLSearchParams`) — the identical collapse-to-`"{}"` shape,
  closed as one class rather than left as a known gap for three of the seven.
  A `Date`/`Map`/`Set`-param endpoint is now correctly excluded from caching
  and coalescing instead of risking one caller's response being served to
  another's different payload.
- **A shared call under `share: true` no longer reports to `onError` more (or
  fewer) times than the identical non-shared call would.** A sharer that
  gives up reports its own failure directly — correct when it isn't the last
  reference, since the shared request keeps running and nothing else would
  ever report that give-up. But when it *is* the last reference, releasing
  also aborts the shared request, and the shared operation *usually* then
  reports that same failure again through its own, normal post-execution
  hook — doubling it. `ShareTracker.release()` now reports whether its
  release was the one that aborted the shared request, and the per-caller
  path reports only when it was not — **except** when the shared operation's
  own hook would never report at all: if the shared middleware chain rejects
  instead of resolving (a middleware that throws on abort — a token-fetching
  auth middleware is the realistic case), or short-circuits to a *success*
  regardless of the abort (a `cacheMiddleware` hit, which ignores the
  signal). Both used to mean the cancellation vanished from `onError`
  entirely — worse than the duplicate this fix removes — so the last-release
  path now watches what the shared operation actually does and reports
  itself whenever the delegate didn't (and won't). A related "cross-kind"
  duplicate — a caller that already gave up still had a live rejection
  handler on the shared promise, which built and reported a *second*,
  differently-kinded failure when the shared operation later rejected, even
  though the Result it built was discarded — is fixed the same way: a caller
  that has already finished no longer reports again.
- **`timeout: 0.5` (or any sub-millisecond value) no longer silently means "no
  timeout".** `Math.floor` flooring a positive-but-fractional deadline to `0`
  failed the "must be positive" check and left the request unbounded — the
  opposite of the caller's intent. A resolved deadline greater than zero is
  now clamped up to a 1ms minimum instead of down to nothing; `0`, negative,
  `NaN`, and omitted still all mean "no timeout".
- **`retryMiddleware`'s `maxDelay: NaN` no longer collapses backoff to a tight
  retry burst.** `Math.min(computed, maxDelay)` is `NaN` whenever `maxDelay`
  is, and the existing backstop then clamped that `NaN` down to `0` — turning
  the whole point of a backoff policy (bounding retries, not eliminating the
  delay) inside out. `maxDelay` is now validated where it's resolved and
  falls back to its default (`30_000`) when it is specifically `NaN`, before
  it ever reaches the arithmetic; `baseDelay` gets the identical treatment,
  for the identical reason (it poisons the same computation the same way).
  **`maxDelay: Infinity` (and `baseDelay: Infinity`) are accepted, not
  redirected to the default** — `Infinity` is the documented "no cap" idiom
  (`Math.min(computed, Infinity)` is always `computed`), so only `NaN` is
  guarded against, not "not finite" generally.

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

[4.4.0]: https://github.com/iremlopsum/apify/compare/v4.3.0...v4.4.0
[4.3.0]: https://github.com/iremlopsum/apify/compare/v4.2.1...v4.3.0
[4.2.1]: https://github.com/iremlopsum/apify/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/iremlopsum/apify/compare/v4.1.1...v4.2.0
[4.1.1]: https://github.com/iremlopsum/apify/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/iremlopsum/apify/compare/v4.0.2...v4.1.0
[4.0.2]: https://github.com/iremlopsum/apify/compare/v4.0.1...v4.0.2
[4.0.1]: https://github.com/iremlopsum/apify/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/iremlopsum/apify/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/iremlopsum/apify/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/iremlopsum/apify/compare/v2.2.1...v3.0.0
[2.2.1]: https://github.com/iremlopsum/apify/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/iremlopsum/apify/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/iremlopsum/apify/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/iremlopsum/apify/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/iremlopsum/apify/releases/tag/v1.0.0
