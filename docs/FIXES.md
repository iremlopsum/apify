# apify — Audit: Fixes

**Date:** 2026-09-13
**Version audited:** 2.0.0 (`03e2cab`, branch `main`)
**Method:** Full read of `src/`, then throwaway probe tests run against the real
implementation to confirm each finding. Every item below was **observed**, not
inferred. Probe output is quoted verbatim. The probe files were deleted; the
repo was not modified.

Companion document: [FEATURES.md](./FEATURES.md)

---

## Summary

| #  | Issue | Severity | Breaking to fix? |
|----|-------|----------|------------------|
| 1  | `Result` isn't a discriminated union — README's headline example doesn't compile | **High** | Yes (types only) |
| 2  | Dedupe `clear()` deletes the wrong controller | **High** | No |
| 3  | Missing path param ships the literal `:token` *and* duplicates it as a query param | **High** | No |
| 4  | A cache hit still aborts a live in-flight request | **High** | No |
| 5  | Malformed JSON on a 200 is reported as `status: 0` with `response: null` | **High** | Yes (behavioural) |
| 6  | `result.response` body is already consumed | Medium | No (docs or `clone()`) |
| 7  | `Request<TParams, TResponse>` has no phantom fields — all Requests mutually assignable | Medium | Yes (types only) |
| 8  | `baseUrl` + `path` naive concat produces `//` | Medium | No |
| 9  | Middleware can't see or replace the abort signal | Medium | No (additive) |
| 10 | `onError` fires for self-inflicted aborts; aborts indistinguishable from offline | Medium | Yes (behavioural) |
| 11 | GraphQL discards partial data when `errors` is present | Medium | Yes (behavioural) |
| 12 | Tooling hygiene: dead eslint-disables, no CI, incomplete `prepublishOnly` | Low | No |
| —  | [Package size: 222 KB → 77 KB](#package-size) | — | No |

Items 1, 5, 10 and 11 are behavioural/type breaking changes. **Batch them into a
single 3.0.0** rather than shipping them piecemeal.

---

## 1. `Result` isn't a discriminated union

**Severity:** High · **Files:** `src/types.ts:194`

`Result<TResponse>` declares `data` and `error` as independent nullable fields:

```ts
export interface Result<TResponse> {
  data: TResponse | null
  error: ApiError | null
  response: Response | null
  retry: () => Promise<Result<TResponse>>
}
```

TypeScript cannot link them, so narrowing on `error` never narrows `data`.

### Evidence

`README.md:226` promises `// data is typed as User, error is null`. The exact
pattern the README advertises:

```ts
const { data, error } = await api.getUser({ id: '1' })
if (error) { console.error(error.status); return }
console.log(data.name)
```

```
t2.ts(10,15): error TS18047: 'data' is possibly 'null'.
```

### Why it matters

Every consumer writes `data!` or a redundant `if (!data) return`. This undercuts
the *Typed dot-access* and *Never throws* pillars at the same time — the entire
point of returning a Result instead of throwing is that the check **is** the
narrowing. Right now the check buys you nothing.

### Fix

```ts
type SuccessResult<T> = { data: T;    error: null;     response: Response;        retry: ... }
type ErrorResult<T>   = { data: null; error: ApiError; response: Response | null; retry: ... }
export type Result<T> = SuccessResult<T> | ErrorResult<T>
```

The three factories in `src/result.ts` already produce exactly these two shapes —
this is a **types-only change with zero runtime cost**. It is breaking for anyone
who annotates `Result<T>` by hand or constructs one in a custom middleware.

---

## 2. Dedupe `clear()` deletes the wrong controller

**Severity:** High · **Files:** `src/create-api.ts:518`, `src/utils/dedupe.ts:161`

`create-api.ts:518` calls `dedupeTracker.clear(name)` unconditionally in the
post-execution `.then`. When request B supersedes request A, A settles *after* B
has already registered its controller — so **A's cleanup deletes B's entry**.

### Evidence

Probe: A starts → B starts (aborts A) → A settles → C starts. C should abort B.

```
B aborted after C started? false
```

### Why it matters

Dedupe silently stops working after the very first cancellation. That is exactly
the search-as-you-type scenario the feature exists for — the second keystroke
works, every keystroke after it races.

### Fix

Make `clear` identity-aware:

```ts
// dedupe.ts
clear(key: string, controller?: AbortController): void {
  if (controller && this.controllers.get(key) !== controller) return
  this.controllers.delete(key)
}
```

`track()` should return the controller (or a handle) so `create-api.ts` can pass
it back. Same fix needed in `src/graphql.ts:183`.

---

## 3. Missing path param ships the literal `:token` and duplicates it as a query param

**Severity:** High · **Files:** `src/utils/path-params.ts:84-97`

`buildUrl` substitutes only params whose key matches a `:token`. Anything else
falls through to `remaining`. **Nothing checks for `:tokens` left unfilled.**

### Evidence

A one-character mismatch between `TParams` and `path`:

```ts
new Request<{ id: string }, User>({ method: 'GET', path: '/users/:userId' })
await api.getUser({ id: '42' })
```

```
URL sent: /api/users/:userId?id=42
```

No error, no warning. The token ships literally, and the value is silently
appended as a query param.

### Why it matters

This is the failure mode that costs the most debugging time of anything in the
library — a wrong URL that looks plausible in a network tab.

### Fix

**Runtime:** after substitution, scan `resolvedPath` for a residual `/:\w+/` and
throw a `TypeError`. The existing sync catch in `create-api.ts:527` already
converts that into a Result, so the *never throws* contract holds.

**Compile time:** see [Feature 1 — path param inference](./FEATURES.md#1-infer-path-params-from-the-path-template).

---

## 4. A cache hit still aborts a live in-flight request

**Severity:** High · **Files:** `src/create-api.ts:296-299` vs `:502`

`effectiveSignal` is computed at `:296`, **before** `composeMiddleware` runs at
`:502`. So `dedupeTracker.track()` fires — and aborts the previous request —
even when a short-circuiting middleware (cache) returns without ever touching
the network.

### Evidence

Warm the cache for `id=1`, start a real request for `id=2`, then make a pure
cache hit for `id=1`:

```
fetch call count: 2
in-flight id=2 aborted by a pure cache hit? true
```

### Why it matters

`dedupe: true` and `cacheMiddleware` are both documented features. Composing
them — the obvious thing to do on a hot read endpoint — is broken.

### Fix

Move dedupe registration into `core`, or make the signal lazy (a getter on the
context evaluated at fetch time). Moving it into `core` is cleaner and also sets
up [Issue 9](#9-middleware-cant-see-or-replace-the-abort-signal).

---

## 5. Malformed JSON on a 200 is reported as a network error with `response: null`

**Severity:** High · **Files:** `src/create-api.ts:370`, caught at `:372`

`parseResponse` throws inside `core`'s try block, so the `catch` at `:372`
builds a `status: 0` network error and discards the `Response`.

### Evidence

A server returning an HTML error page with a 200 status:

```
status: 0 | statusText: ""
response is null? true   (the server DID respond 200)
error.body: SyntaxError: Unexpected token '<', "<html>oops</html>" is not valid JSON
```

### Why it matters

You lose the status, the headers and the raw body — everything needed to
diagnose it. Worse, `status: 0` means `retryMiddleware` won't touch it and any
`error.status === 0` handler will tell the user they're offline when they aren't.

### Fix

Parse inside its own try/catch and emit a `createErrorResult` that keeps the
real `Response`. Pairs naturally with the `error.kind` discriminator from
[Issue 10](#10-onerror-fires-for-self-inflicted-aborts):

```ts
error.kind === 'parse'   // server responded, body didn't parse
```

---

## 6. `result.response` body is already consumed

**Severity:** Medium · **Files:** `src/create-api.ts:350`, `:370`

Both the success and error paths call `parseResponse`, which drains the stream.
The `Response` handed back in the Result is unusable for anything body-shaped.

### Evidence

```
bodyUsed: true
re-read error: Body is unusable: Body has already been read
```

### Why it matters

`response.headers` and `.status` work, so it looks fine until someone reaches
for `.json()` or `.text()`. It isn't mentioned in the README's Result table or
the `ApiError` docs.

### Fix

Either `response.clone()` before parsing (costs buffering), or document the
constraint explicitly in the README Result section. Documenting is probably the
right call given the zero-overhead philosophy — but it must be documented.

---

## 7. `Request<TParams, TResponse>` has no phantom fields

**Severity:** Medium · **Files:** `src/request.ts:99`

The class body never references `TParams` or `TResponse`, so TypeScript treats
every instantiation as structurally identical.

### Evidence

Both of these compile clean with `--strict`:

```ts
const wrong: Request<{ id: string }, User> = getPost         // no error
function needsUserReq(_r: Request<{ id: string }, User>) {}
needsUserReq(getPost)                                         // no error
```

### Why it matters

`Operation` in `src/graphql.ts:15` already does this correctly:

```ts
declare readonly _variables: TVariables
declare readonly _data: TData
```

So the library is internally inconsistent. Inference into `createApi` still works
today (it resolves through the type reference), but any user-written helper that
accepts a typed `Request` gets zero protection.

### Fix

Add the same two `declare readonly` phantom fields to `Request`.

---

## 8. `baseUrl` + `path` is naive string concatenation

**Severity:** Medium · **Files:** `src/utils/path-params.ts:102`

```ts
let url = `${baseUrl}${resolvedPath}`
```

### Evidence

```ts
createApi({ baseUrl: 'https://x.com/', requests: { h: /* path: '/health' */ } })
```

```
URL sent: https://x.com//health
```

### Why it matters

A trailing slash is the shape you get from `process.env.API_URL` most of the
time. Some servers 404 on a double slash; some redirect — and a cross-origin
redirect drops the `Authorization` header.

### Fix

One-line normalisation: strip a trailing `/` from `baseUrl` when `resolvedPath`
starts with `/`.

---

## 9. Middleware can't see or replace the abort signal

**Severity:** Medium · **Files:** `src/types.ts:283-302`, `src/create-api.ts:326`

### Evidence

```
ctx.request keys: [ 'method', 'url', 'path', 'params', 'headers', 'body' ]
```

`core` closes over `effectiveSignal` at `create-api.ts:326`, so it is
unreachable from userland.

### Why it matters

This makes an entire class of middleware impossible to write: timeouts, deadline
propagation, cancel-on-condition. Given *middleware over interceptors* is a
stated pillar, it's the biggest hole in the extension model — and it blocks
[Feature 2 (timeout)](./FEATURES.md#2-first-class-timeout).

### Fix

Add `signal` to `MiddlewareContext.request`, writable, and have `core` read it
from the context rather than the closure. Best done together with
[Issue 4](#4-a-cache-hit-still-aborts-a-live-in-flight-request).

---

## 10. `onError` fires for self-inflicted aborts

**Severity:** Medium · **Files:** `src/create-api.ts:523`

### Evidence

```
onError calls: 1 | error status: 0 | body name: AbortError
```

### Why it matters

Two problems in one:

1. **Every dedupe cancellation hits your global `onError`** — i.e. Sentry — as
   an error, when the library caused it deliberately.
2. **Aborts and genuine network failures are both `status: 0`.** The only way to
   tell them apart is `(error.body as Error).name === 'AbortError'`, poking at
   an `unknown` field.

### Fix

Add a discriminator to `ApiError`:

```ts
kind: 'http' | 'network' | 'abort' | 'parse'
```

and skip `onError` for `kind === 'abort'` by default. Pairs with
[Issue 1](#1-result-isnt-a-discriminated-union) and
[Issue 5](#5-malformed-json-on-a-200-is-reported-as-a-network-error-with-response-null).

---

## 11. GraphQL discards partial data when `errors` is present

**Severity:** Medium · **Files:** `src/graphql.ts:138-147`

```ts
if (gqlBody?.errors?.length) {
  const error = new ApiError({ ..., body: gqlBody.errors, ... })
  return createErrorResult(error, response, execute)   // gqlBody.data dropped
}
```

### Why it matters

The GraphQL spec explicitly supports partial success — a nullable field errors
while the rest of the query resolves. Consumers of a federated or
nullable-heavy schema hit this routinely and currently have **no way to recover
the data at all**.

### Fix

Carry partial data through on the error Result (`data` populated *and* `error`
populated), or expose it on the error. Note this interacts with
[Issue 1](#1-result-isnt-a-discriminated-union) — a strict discriminated union
forbids "both populated", so decide the shape deliberately. A separate
`error.partialData` field keeps the union clean.

---

## 12. Tooling hygiene

**Severity:** Low

### 17 dead `eslint-disable` comments

```
src/create-api.ts:4
src/graphql.ts:13
```

No ESLint is installed or configured — no config file, nothing in
`node_modules`. These suppress nothing; they just imply a linter that doesn't
exist. Either add `typescript-eslint` or delete them.

### No CI

There is no `.github/` directory at all. 135 unit tests plus a real integration
suite, and nothing runs them on push.

### `prepublishOnly` is incomplete

```json
"prepublishOnly": "npm run test:run && npm run build"
```

Runs unit tests but **not** `typecheck` and **not** `test:integration`. The
integration suite is the one that exercises real `fetch` against a real server —
it's the one you most want gating a publish.

```json
"prepublishOnly": "npm run typecheck && npm run test:run && npm run test:integration && npm run build"
```

---

## Package size

Two different numbers here, and they tell opposite stories.

### The runtime footprint is already excellent — leave it alone

Measured with esbuild against the real `dist/`:

| Import | Minified | Gzipped |
|--------|----------|---------|
| REST only (`createApi` + `Request`) | 4,180 B | **1,778 B** |
| Everything (REST + GraphQL + all middleware) | 7,586 B | **2,887 B** |

Tree-shaking already drops GraphQL entirely from a REST-only import. **Under
2 KB gzipped for the core is a headline feature — the README should say so.**

### The npm package is ~90% waste

222 KB unpacked / 61 KB packed, for 22 KB of actual JavaScript.

| Component | Bytes | Verdict |
|-----------|-------|---------|
| `.js` | 95,146 | **73 KB of it is comments** — 22 KB with `removeComments` |
| `.d.ts` | 55,519 | **Keep.** This is your editor hover documentation. |
| `.js.map` + `.d.ts.map` | 41,756 | **Dead weight.** See below. |

The source maps are not a tradeoff, they're broken. Verified:

```
sources: [ '../src/create-api.ts' ]   sourcesContent: NO
```

`src/` is not in the `files` array, so the maps reference files that are never
shipped, with no inlined content. They resolve to nothing in every consumer
environment — 42 KB shipped to break in a debugger.

### The fix — a two-step build

The split matters: `removeComments` alone would **also** strip JSDoc from the
`.d.ts` (55 KB → 8 KB), killing every hover tooltip. Emitting declarations
separately keeps them. Verified: JSDoc survives intact in the recommended output.

```jsonc
// package.json
"build": "tsc -p tsconfig.build.json && tsc -p tsconfig.types.json",
"sideEffects": false
```

```jsonc
// tsconfig.build.json  — JS only
{ "extends": "./tsconfig.json",
  "compilerOptions": {
    "removeComments": true, "declaration": false, "sourceMap": false } }
```

```jsonc
// tsconfig.types.json  — declarations only, JSDoc preserved
{ "extends": "./tsconfig.json",
  "compilerOptions": {
    "emitDeclarationOnly": true, "declarationMap": false, "sourceMap": false } }
```

### Result

| | Unpacked | Packed |
|---|----------|--------|
| Current | 222 KB | 61 KB |
| Recommended | **107 KB** | **~30 KB** |
| | **−52%** | **−51%** |

Zero DX loss — same hover docs, same types, same tree-shaking, same runtime bytes.

Add `"sideEffects": false` regardless. esbuild tree-shakes correctly without it,
but webpack and Rollup are more conservative — it's the difference between a
consumer shipping 1.8 KB and 2.9 KB.

---

## Suggested order

1. **Size fix** — ~30 minutes, −65%, non-breaking, independent of everything else.
2. **Issues 2, 3, 4, 8** — four confirmed bugs, all small, all silent-failure class, all non-breaking.
3. **Issues 1, 5, 10, 11 + 7** — the breaking batch. Ship as **3.0.0** together, since they all touch `Result`/`ApiError` shape.
4. **Issue 9** — additive, and it unblocks [Feature 2](./FEATURES.md#2-first-class-timeout).
5. **Issue 12** — hygiene, do it whenever.
