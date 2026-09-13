# apify — Audit: Proposed Features

**Date:** 2026-09-13
**Version audited:** 2.0.0 (`03e2cab`, branch `main`)

Ten proposals, ranked by leverage. Each was filtered against the library's own
stated philosophy — **zero dependencies**, **never throws**, **inference over
annotation**, **middleware over interceptors**, **runtime-agnostic**. Anything
that would compromise one of those pillars was cut or reshaped.

Companion document: [FIXES.md](./FIXES.md)

---

## Summary

| #  | Feature | Why it matters | Blocked by |
|----|---------|----------------|------------|
| 1  | [Infer path params from the path template](#1-infer-path-params-from-the-path-template) | The differentiator. Kills a whole bug class at compile time. | — |
| 2  | [First-class `timeout`](#2-first-class-timeout) | Table stakes. The #1 reason people reach for axios. | [Fix 9](./FIXES.md#9-middleware-cant-see-or-replace-the-abort-signal) |
| 3  | [A real retry policy](#3-a-real-retry-policy) | Current retry is a thundering-herd generator. | — |
| 4  | [In-flight coalescing (`share: true`)](#4-in-flight-coalescing-share-true) | 3 identical GETs → 1 network call. | — |
| 5  | [Runtime response validation](#5-runtime-response-validation-via-standard-schema) | Makes `TResponse` true instead of aspirational. | — |
| 6  | [`api.extend(...)`](#6-apiextend-for-derived-clients) | Multi-tenant / per-token clients without redefining requests. | — |
| 7  | [URL & `Request` introspection](#7-url--request-introspection-escape-hatch) | SSR prefetch, preload, service workers, testing. | — |
| 8  | [Pagination as an async iterator](#8-pagination-as-an-async-iterator) | Everyone hand-rolls this loop. | — |
| 9  | [Streaming / SSE response type](#9-streaming--sse-response-type) | The reason people can't use a fetch wrapper at all. | — |
| 10 | [A `./testing` entry point](#10-a-testing-entry-point) | You already did the hard work; ship it. | — |

---

## 1. Infer path params from the path template

**The flagship.** This is the single most differentiating thing the library
could ship.

```ts
const getUser = new Request({ method: 'GET', path: '/users/:id' })

api.getUser({ id: '42' })       // ✓
api.getUser({ userId: '42' })   // ✗ compile error
```

### How

A template-literal type that walks the path and extracts `:token` segments,
intersected with an explicit generic for non-path params:

```ts
type PathParams<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string | number } & PathParams<`/${Rest}`>
    : P extends `${string}:${infer Param}`
      ? { [K in Param]: string | number }
      : {}

// PathParams<'/orgs/:org/repos/:repo'> → { org: ...; repo: ... }
```

`Request` then becomes `Request<TExtra, TResponse, TPath>` where the effective
params are `PathParams<TPath> & TExtra`.

### Why

This turns [Fix 3](./FIXES.md#3-missing-path-param-ships-the-literal-token-and-duplicates-it-as-a-query-param)
— a silent wrong-URL bug — into a red squiggle in the editor. It's exactly the
*"type safety from inference, not annotation"* pillar applied to the one place
the library currently doesn't apply it.

### Cost

The type gymnastics are real but bounded, and they're compile-time only — zero
runtime bytes. The migration path needs thought: existing consumers pass
`TParams` explicitly, so the new generic has to be additive or the change is
breaking.

---

## 2. First-class `timeout`

```ts
new Request({ method: 'GET', path: '/slow', timeout: 5000 })
await api.getSlow({}, { timeout: 1000 })   // per-call override
```

### How

`AbortSignal.timeout()` composed against the caller's signal and the dedupe
signal. All three merge into one effective signal.

### Why

Table stakes for every fetch wrapper, and the most common reason people reach
for axios instead of `fetch`. Currently there is **no** way to bound a request's
duration — not via config, not via middleware
([Fix 9](./FIXES.md#9-middleware-cant-see-or-replace-the-abort-signal) explains
why middleware can't do it either).

### Depends on

[Fix 9](./FIXES.md#9-middleware-cant-see-or-replace-the-abort-signal) — the
signal must be reachable and replaceable from the middleware context first.
Once it is, `timeout` could even ship as built-in middleware rather than config.

---

## 3. A real retry policy

`retryMiddleware` currently hammers with zero delay. Measured:

```
4 attempts took 0 ms — no backoff, no Retry-After respect, no jitter
```

### What to add

```ts
retryMiddleware({
  max: 3,
  backoff: 'exponential',        // base delay × 2^attempt
  jitter: true,                   // full jitter, avoids synchronised retries
  respectRetryAfter: true,        // honour the header on 429/503
  retryOn: (result) => result.error?.status >= 500,   // opt in to 429, network
})
```

### Why

As written, `retryMiddleware(3)` fires four requests in the same tick at a
server that is already struggling. That's a thundering-herd generator pointed at
your own backend. `Retry-After` is the server explicitly telling you when to come
back — ignoring it is the difference between recovering and getting rate-limited.

`retryOn` also resolves the documented-but-arbitrary limitation that network
errors (`status: 0`) and 429s aren't retried: make it a predicate and the
default stays conservative while the escape hatch exists.

### Note

Keep the existing signature working — `retryMiddleware(3)` should still mean
"3 retries with sensible defaults". Accept either a number or an options object.

---

## 4. In-flight coalescing (`share: true`)

Three identical simultaneous GETs currently make **3 network calls**:

```
network calls for 3 identical simultaneous requests: 3
```

### What

```ts
new Request({ method: 'GET', path: '/me', share: true })
```

Ten components mounting and each asking for `/me` produces **one** request; all
ten await the same promise.

### Why

This is a sibling of `dedupe`, not a replacement:

| | Behaviour |
|---|---|
| `dedupe: true` | **Cancels** the older request — "only the newest matters" (search-as-you-type) |
| `share: true` | **Joins** the in-flight request — "we all want the same thing" (`/me`, config, feature flags) |

Different tool, same family. Small addition next to `DedupeTracker` — a
`Map<key, Promise<Result>>` keyed on request name + stable-stringified params
(`stableStringify` from `src/utils/cache.ts` already exists and does exactly
this).

### Watch out for

`retry()` on a shared result, and making sure the entry is cleared on settle —
[Fix 2](./FIXES.md#2-dedupe-clear-deletes-the-wrong-controller) is the cautionary
tale for getting that cleanup right.

---

## 5. Runtime response validation via Standard Schema

```ts
new Request({ method: 'GET', path: '/users/:id', schema: UserSchema })
```

### Why

`TResponse` is currently an **unchecked assertion**. The server can return
anything and your types lie about it — silently, until something downstream
explodes with a confusing error far from the cause. This is the feature that
makes the library's type safety *true* rather than aspirational.

### The zero-dependency angle

[Standard Schema](https://standardschema.dev) is an **interface, not a package**.
Zod, Valibot and ArkType all implement it. Accepting
`StandardSchemaV1<unknown, TResponse>` means:

- Consumers bring their own validator
- apify takes **no dependency** — the pillar holds
- `TResponse` can be *inferred from the schema*, so you stop writing it twice

### Error shape

Validation failures become an error Result, not a throw:

```ts
error.kind === 'parse'   // see FIXES.md #5 and #10
```

which is the same discriminator the malformed-JSON fix introduces. These two
should be designed together.

---

## 6. `api.extend(...)` for derived clients

```ts
const tenantApi = api.extend({
  headers: { 'X-Tenant': tenantId },
  middleware: [tenantAuth],
})
```

### Why

Multi-tenant apps, per-user tokens in SSR, and test fixtures all currently
require **redefining the entire `requests` record** to change one header. That's
the kind of friction that makes people wrap the wrapper.

### How

Cheap: re-run `createApi` with merged config. The only real decisions are merge
semantics (append vs replace for middleware — append, matching the existing
global/per-request/per-call layering) and whether the derived client shares the
parent's `DedupeTracker` (it should not — independent state, matching the
existing per-`createApi` rule).

---

## 7. URL & `Request` introspection escape hatch

```ts
api.getUser.url({ id: '42' })        // '/api/users/42'
api.getUser.toRequest({ id: '42' })  // a native Request object
```

### Why

Needed for:

- **SSR prefetch** and `<link rel="preload">`
- **Service-worker** cache priming
- **Next.js** `fetch()` tagging and revalidation
- **Tests** that assert on the URL without stubbing `fetch`

None of these are possible today — URL construction is locked inside
`execute()`.

### How

Purely additive: attach properties to the generated method function in
`create-api.ts`. `buildUrl` is already a pure, separately-testable function, so
`url()` is a thin wrapper over existing code.

---

## 8. Pagination as an async iterator

```ts
for await (const page of api.listItems.pages({ limit: 50 }, {
  next: (result) => result.data.cursor,
})) {
  render(page.data.items)
}
```

### Why

Every consumer hand-rolls this loop, and everyone gets the termination condition
slightly wrong. A small generic helper — given a "how do I get the next page"
extractor — covers cursor, offset and `Link`-header pagination with the same
shape.

### Design note

Keep the extractor explicit rather than guessing at conventions. Guessing is how
you end up with a config option for every API in existence; the same reasoning
that led `buildUrl` to **refuse** to pick a nested-query-string convention
applies here.

---

## 9. Streaming / SSE response type

```ts
new Request({ method: 'POST', path: '/chat', responseType: 'stream' })

const { data } = await api.chat({ prompt })
for await (const chunk of data) { ... }
```

### Why

Increasingly the reason people **can't use a fetch wrapper at all** — LLM
endpoints, progress feeds, log tailing. Today `responseType` has five options
and none of them let you read a body incrementally.

### Fits the philosophy

It's just `ReadableStream` — a standard web API available in every target
runtime the README claims (browsers, Node 18+, Bun, Deno, Workers). No
dependency, no runtime assumption. An SSE line parser is ~30 lines on top.

### Watch out for

`retry()` semantics on a consumed stream, and the interaction with
[Fix 6](./FIXES.md#6-resultresponse-body-is-already-consumed) — streaming is the
one case where the body deliberately must *not* be pre-drained.

---

## 10. A `./testing` entry point

```ts
import { mockApi } from '@iremlopsum/apify/testing'

const api = mockApi(realApi, {
  getUser: { data: { id: '1', name: 'Ada' } },
  listItems: { error: { status: 500 } },
})
```

### Why

You already have the hard-won knowledge — 13 test files and two different
mocking strategies (globally stubbed `fetch` for unit tests, a real `node:http`
server for integration). Shipping it means consumers don't re-derive
`vi.stubGlobal('fetch', ...)` and get the `Result` shape subtly wrong.

A third entry point costs consumers **nothing** thanks to tree-shaking — the
core REST import currently measures 1,778 B gzipped and a `./testing` subpath
never enters a production bundle.

---

## Also considered, ranked lower

| Idea | Verdict |
|------|---------|
| `onRequest` / `onResponse` lifecycle hooks | `onError` currently has no siblings, which looks asymmetric — but middleware already covers this cleanly. Adding hooks would violate *middleware over interceptors*. **Skip.** |
| GraphQL persisted queries / APQ | Real value for production GraphQL, but niche relative to the list above. **Later.** |
| Auth refresh-and-replay | Should be a **documented recipe**, not an API. The middleware onion plus `retry()` already expresses it — the gap is docs, not capability. |
| GraphQL `operationName` extraction from the document | Nice-to-have for server-side logging and tracing. Low effort, low urgency. |

---

## Suggested order

1. **[Feature 1](#1-infer-path-params-from-the-path-template)** — the differentiator, and it retires [Fix 3](./FIXES.md#3-missing-path-param-ships-the-literal-token-and-duplicates-it-as-a-query-param) permanently.
2. **[Feature 3](#3-a-real-retry-policy)** — smallest effort-to-value ratio on the list; the current behaviour is actively harmful.
3. **[Feature 2](#2-first-class-timeout)** — but land [Fix 9](./FIXES.md#9-middleware-cant-see-or-replace-the-abort-signal) first.
4. **[Feature 5](#5-runtime-response-validation-via-standard-schema)** — design alongside the `error.kind` discriminator from the [3.0.0 breaking batch](./FIXES.md#suggested-order).
5. Everything else as demand dictates.
