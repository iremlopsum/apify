# Migration Guide

Upgrade notes for `@iremlopsum/apify`. Only releases that need action appear
here — if a version isn't listed, upgrading to it requires no changes.

For the full record of what changed in each release, see [CHANGELOG.md](./CHANGELOG.md).

---

## Upgrading to 4.0.0

One rule changes: **a success must carry data.** If you declared
`responseType: 'none'` on the endpoints 3.1.0's warning named, this release is
a no-op for you.

### 1. An empty body under `responseType: 'json'` is now an error

```ts
// A DELETE that answers 204 No Content, responseType left at the default:

// 3.x
const { data, error } = await api.deleteUser({ id: '42' })
// error === null, data === null  -- and `data.deleted` compiles, then throws

// 4.0.0
const { data, error } = await api.deleteUser({ id: '42' })
// error.kind === 'parse', error.status === 204, data === null
```

This is what makes `SuccessResult.data: TResponse` true. 3.0.0 made `Result<T>`
a discriminated union so `if (error) return` narrows `data` — but an empty body
produced `null` behind a non-null `TResponse`, so the narrowing was a lie for
exactly the endpoints least likely to be checked.

**The fix, on every endpoint that answers with no body:**

```ts
const deleteUser = new Request<{ id: string }, undefined>({
  method: 'DELETE',
  path: '/users/:id',
  responseType: 'none',   // available since 3.1.0
})
```

`'none'` reads no body on success, so it never reaches the rule. Non-2xx
responses are unaffected — their body is still read and parsed for
`error.body`, on `'none'` as on `'json'`.

**There is no 204 special case.** One rule — declared JSON, got no JSON —
applies at every status. A `200` with an empty body behaves identically to a
`204`.

**A literal `null` body still succeeds.** `JSON.parse("null")` is valid JSON, so
a server that sends the body `null` is sending data. Only a zero-length body is
an error.

**Which endpoints are affected?** 3.1.0 told you, by name, once per request:
any endpoint that logged `[apify] <name>: server returned an empty body`. If you
are coming from 3.1.0 and never saw that warning in development or staging, no
endpoint of yours hits this path.

### 2. A GraphQL response with no `data` is now an error

The same rule, at the GraphQL client's own seam. A 2xx response carrying
neither `data` nor `errors` used to resolve as a success with `data: null`:

```ts
// Server returns 200 with body {}  (or "", or {"data": null})

// 3.x
const { data, error } = await client.getUser({ id: '1' })
// error === null, data === null

// 4.0.0
const { data, error } = await client.getUser({ id: '1' })
// error.kind === 'parse', error.status === 200, error.body === '{}'
```

`error.body` carries the raw response text, which is the only useful answer to
"then what did the server send?".

**GraphQL errors are unchanged.** A `{"data": null, "errors": [...]}` response —
the legitimate shape for a field error — still reports `kind: 'http'` with the
errors in `error.body` and any partial result in `error.partialData`, exactly as
before. Only a response reporting *no* errors and *no* data is affected, which
the GraphQL over HTTP spec does not permit.

### 3. The one-time empty-body warning is gone

3.1.0's `console.warn` has served its purpose and is removed. Nothing replaces
it — the condition it warned about is now reported as an error through the
normal `Result`.

### Nothing to do if…

- every endpoint that returns no body already declares `responseType: 'none'`, or
- you never saw 3.1.0's empty-body warning, or
- your GraphQL server always answers with `data` or `errors` (i.e. it is
  spec-compliant).

In those cases 4.0.0 is a drop-in upgrade.

---

## Upgrading to 3.1.0

3.1.0 is additive — no existing behaviour changed, and no action is required
to upgrade. It adds one new `responseType` option and a diagnostic warning;
read on if either applies to you.

### 1. New: `responseType: 'none'`

Declares that an endpoint returns no body on success — the accurate
declaration for a `204`, or a `200` with an empty body, most commonly a
`DELETE`. Before 3.1.0, that shape only had `responseType: 'json'` (the
default) to reach for, which parses an empty body to `data: null` at runtime
while `TResponse` claims otherwise:

```ts
// Before — TResponse widened to admit the null the endpoint actually returns
const deleteUserBefore = new Request<{ id: string }, { deleted: boolean } | null>({
  method: 'DELETE',
  path: '/users/:id',
})
const before = await api.deleteUserBefore({ id: '42' })
if (before.error) return
if (before.data) console.log(before.data.deleted) // null-check required even though error was null

// After — responseType: 'none' says exactly what happens: no body, ever
const deleteUserAfter = new Request<{ id: string }, undefined>({
  method: 'DELETE',
  path: '/users/:id',
  responseType: 'none',
})
const after = await api.deleteUserAfter({ id: '42' })
if (after.error) return
console.log(after.data) // undefined -- no null-check needed, and none is possible
```

Declare `TResponse` as `undefined` when using `responseType: 'none'` — this
is a convention, not a compile-time guarantee, and `new Request<P,
User>({ responseType: 'none' })` compiles without error. A non-2xx response
is unaffected: its body is still read and parsed as JSON for `error.body`,
since an error body (a message, a code) is worth reading even when the
caller wants nothing back on success.

**Known limitation:** the compiler does not check the `responseType: 'none'`
/ `TResponse` pairing. Mismatch them and `data` is `undefined` at runtime
behind whatever type you declared, with no compile error to catch it.

### 2. You may see a one-time console warning

If any existing endpoint declares `responseType: 'json'` (the default) and
the server answers with an empty body, 3.1.0 now logs this once per request
name, per `createApi` instance:

```
[apify] deleteUser: server returned an empty body for responseType 'json'. This yields data: null today and will be an error in 4.0.0. Declare responseType: 'none' if the endpoint returns no content.
```

This is a diagnostic, not a behaviour change — the call still resolves as a
success with `data: null`, exactly as it always has. It means the named
request is one of the empty-body endpoints described above, and declaring
`responseType: 'none'` on it both makes `TResponse` accurate and silences the
warning.

### 3. Coming in 4.0.0

This shipped. See [Upgrading to 4.0.0](#upgrading-to-400) — an empty body under
`responseType: 'json'` is now a `kind: 'parse'` error, and declaring
`responseType: 'none'` makes that upgrade a no-op.

## Upgrading to 3.0.0

3.0.0 tightens contracts the library always implied but never enforced. Most
of it is types catching up to behaviour that was already there; the error
*classification* changes (parse failures, aborts) change what a `Result`
actually contains for a narrow set of cases. Read the "Nothing to do if…"
section at the end first — it covers the common case.

### 1. `Result<T>` is a discriminated union, not an interface

`data` and `error` used to be independent nullable fields, so `if (error)
return` never narrowed `data` — every consumer had to write `data!` or a
redundant null check. `Result<T>` is now `SuccessResult<T> | ErrorResult<T>`
(both exported), and checking `error` narrows `data` for real:

```ts
const { data, error } = await api.getUser({ id: '42' })
if (error) return
// 2.x → data: User | null, so data!.name (or a redundant `if (!data) return`)
// 3.0.0 → data: User, so data.name — the `!` and the redundant check can go
console.log(data.name)
```

**If you have custom middleware that synthesises a *success* `Result`**
(short-circuits with `{ data, error: null, response, retry }` rather than
calling `next()`), it must now supply a non-null `Response` — the type no
longer allows `response: null` on the success branch. There is no runtime
change here: the library's own factories (`createSuccessResult` and friends)
already only ever produced exactly these shapes, so this is a compile-time
tightening, not a behaviour change, for any middleware that was already
well-formed.

### 2. `Request` generics are no longer interchangeable

`Request<TParams, TResponse>` never referenced its own generics in the class
body, so every instantiation was structurally identical to TypeScript and
`Request<{ id: string }, User>` silently accepted a `Request<{ slug: string
}, Post>` wherever one was expected. Phantom fields now make the generics
load-bearing:

```ts
const getUser = new Request<{ id: string }, User>({ method: 'GET', path: '/users/:id' })
const getPost = new Request<{ slug: string }, Post>({ method: 'GET', path: '/posts/:slug' })

function useRequest(r: Request<{ id: string }, User>) { /* ... */ }

useRequest(getUser)  // fine, always was
useRequest(getPost)
// 2.x   → compiled (both Requests looked identical to the type system)
// 3.0.0 → compile error: Request<{ slug: string }, Post> is not assignable
//         to Request<{ id: string }, User>
```

**What to do:** if this fires after upgrading, the assignment was already
wrong — the two `Request`s describe different endpoints and were never
actually interchangeable at runtime. Fix the annotation to match the real
endpoint.

### 3. `ApiError.kind` is required, and gained `'middleware'`

`kind` shipped optional in 2.2.0; every construction site inside the library
already set it, so this is the type catching up. `ApiErrorKind` is now
`'http' | 'network' | 'abort' | 'timeout' | 'parse' | 'middleware'`.

```ts
// Custom middleware constructing its own ApiError (e.g. to short-circuit
// with a validation failure) must now supply `kind`:
new ApiError({
  status: 422,
  kind: 'http',            // 3.0.0: required — omitting this is a type error
  statusText: 'Unprocessable Entity',
  body: { message: 'invalid payload' },
  headers: new Headers(),
  request: { method: 'POST', url, params },
})
```

**If you have an exhaustive `switch (error.kind)`** (or a mapped type keyed on
`ApiErrorKind`), it needs a new `'middleware'` arm — see #5 below for what
produces it.

### 4. Parse failures on a 2xx response changed shape

**Scope: 2xx responses only.** A 2xx response whose body failed to parse
according to `responseType` previously reported `status: 0`, `response:
null`, `kind: 'network'` — indistinguishable from being offline, and the
`Response` (status, headers) was discarded even though the server did
respond. It now reports the real `status`, a non-null `response`, and `kind:
'parse'`:

```ts
const { error } = await api.getUser({ id: '42' })  // server sent 200 with an unparseable body
// 2.x   → error.status === 0, error.response === null, error.kind === 'network'
// 3.0.0 → error.status === 200, error.response !== null, error.kind === 'parse'
```

**Non-2xx responses are unaffected.** `!response.ok` is checked before the
body is parsed, so a 5xx with an unparseable body already reported (and still
reports) `kind: 'http'` with the real status — **`retryMiddleware`'s default
5xx retry behaviour has not changed.** Do not treat this as "parse errors are
now retried differently"; only the 2xx case moved.

**What to do:** code that branched on `status === 0` (or `kind === 'network'`)
to mean "the user is offline" now needs to also handle `kind: 'parse'`
explicitly if it wants to keep distinguishing "offline" from "the server
responded with something we couldn't read." Code that only checked `if
(error)` and logged generically needs no changes.

### 5. A throwing middleware returns a `Result` instead of rejecting

`composeMiddleware`'s dispatch has no guard, so an `async` middleware that
threw used to reject the caller's promise — breaking the "never throws"
contract for the one path most likely to have a bug (your own middleware). It
now produces an ordinary `Result` with `kind: 'middleware'`:

```ts
const buggyMiddleware: Middleware = async (ctx, next) => {
  throw new Error('oops')
}

// 2.x
try {
  const result = await api.getUser({ id: '42' })
} catch (err) {
  // had to catch here — a middleware bug rejected the call
}

// 3.0.0 — no try/catch needed; remove it
const { error } = await api.getUser({ id: '42' })
if (error?.kind === 'middleware') {
  // error.body is the Error the middleware threw
}
```

**What to do:** delete any `try`/`catch` you placed around an API call
specifically to catch a middleware's throw. It's dead code now — the call
never rejects — and the failure is available as `error.kind === 'middleware'`
instead.

### 6. `onError` no longer fires for `error.kind === 'abort'`

Every `dedupe` supersede and every caller-initiated cancellation used to reach
`onError` — i.e. your Sentry — as a reported error, even though the library
caused it deliberately. `'timeout'` is unaffected and still fires: a deadline
you missed is a real failure, unlike a cancellation you caused yourself.

```ts
const controller = new AbortController()
const promise = api.getUser({ id: '42' }, { signal: controller.signal })
controller.abort()
await promise
// 2.x   → onError(error) fires with error.kind === 'abort'
// 3.0.0 → onError does not fire; the caller still gets the abort Result back
```

**What to do:** delete any hand-rolled filtering you added to your `onError`
handler to ignore `AbortError`/cancellations (e.g. `if (error.body?.name ===
'AbortError') return`) — the library now does this for you, unconditionally,
for every abort it produces.

### 7. Aborts are classified by provenance, not by the reason's name

This is the change most likely to surface silently, because it changes
`kind` for shapes that used to look like something else entirely.
Previously, the library guessed a cancellation by sniffing the *thrown
value's* `.name` (`'AbortError'` / `'TimeoutError'`). Now it asks a different
question: **did the signal that actually governs this request abort?** If
yes, the failure is `'abort'`/`'timeout'` regardless of what was thrown or
what it's named; if no, sniffing the thrown value's shape is the fallback.
Four consequences:

- **A caller's own custom abort reason is now silent, not reported.**
  `controller.abort(new Error('unmounted'))` or `controller.abort('cancelled')`
  used to fail the old name-based sniff (the reason isn't named
  `AbortError`), so it fell through to `kind: 'network'` and reached
  `onError`. It's now `kind: 'abort'` — correctly classified as *your*
  cancellation — and, per #6, `onError` doesn't fire for it.

  ```ts
  controller.abort(new Error('component unmounted'))
  // 2.x   → error.kind === 'network', reported to onError
  // 3.0.0 → error.kind === 'abort', not reported
  ```

  **What to do:** if you were branching on `error.kind === 'network'` (or
  `error.status === 0`) to mean "offline," and relying on a custom abort
  reason to *also* hit that branch, it no longer will. Branch on `kind ===
  'abort'` explicitly if you still want to observe your own cancellations.

- **A middleware that propagates the library's own abort reason now returns a
  silent `kind: 'abort'` `Result`, instead of rejecting the caller's promise
  outright.** This covers both re-throwing the exact reason (`throw
  ctx.request.signal.reason`) and the shape `node:timers/promises` and most
  abortable helpers actually produce — a fresh `AbortError` whose `.cause` is
  the signal's reason:

  ```ts
  import { setTimeout as delay } from 'node:timers/promises'

  const backoff: Middleware = async (ctx, next) => {
    await delay(100, undefined, { signal: ctx.request.signal })
    return next()
  }
  // if ctx.request.signal aborts during the delay, `delay` rejects with an
  // AbortError whose `.cause` is ctx.request.signal.reason
  // 2.x   → non-shared: composeMiddleware's chain had no rejection handler at
  //         all, so the caller's own promise rejects with the raw AbortError
  //         — no Result, "kind" does not apply, onError never runs.
  //         Under `share: true` specifically, this *was* already converted to
  //         a Result (the share site's own rejection handler, present since
  //         2.2.0), classified `kind: 'abort'` by sniffing the thrown value's
  //         `.name` — the same name-based sniff #7's intro paragraph
  //         describes, so it could not tell this genuine propagation apart
  //         from bullet 3's unrelated-failure case below. Reported either way
  //         (no abort suppression existed yet).
  // 3.0.0 → error.kind === 'abort' (recognised as propagating our own signal,
  //         not merely name-matched), returned as an ordinary Result on every
  //         path, not reported
  ```

  **What to do:** delete any `try`/`catch` you placed around this kind of
  call for the same reason as #5. Code was already correct if it treated this
  as `kind: 'abort'` — it just could not have relied on that being *reliable*
  (see bullet 3, which used to collide with this one under the old
  name-based sniff). Middleware authors: see the "worth knowing" note below
  about not attaching `signal.reason` as `.cause` to your *own* unrelated
  failures — doing so makes them indistinguishable from this propagation
  case.

- **A middleware throwing its own, unrelated `AbortError`-named failure now
  reaches `onError` classified as `'middleware'`, as an ordinary `Result`,
  instead of rejecting the caller's promise outright.** An IndexedDB quota
  abort, say, rethrown by a caching middleware, has nothing to do with this
  request's own signal:

  ```ts
  // 2.x   → non-shared: composeMiddleware's chain had no rejection handler at
  //         all, so the caller's own promise rejects with the raw AbortError
  //         — no Result, "kind" does not apply, onError never runs.
  //         Under `share: true`, this was already converted to a Result, but
  //         misclassified `kind: 'abort'` by the same name-based sniff as
  //         bullet 2 above — 'middleware' did not exist as a kind at all
  //         before this release, on either path — and was reported (no
  //         suppression existed for 'abort' yet either).
  // 3.0.0 → error.kind === 'middleware' (not a propagation of our signal),
  //         returned as an ordinary Result on every path, reported
  ```

  **What to do:** nothing to change in your code, but expect to *start*
  seeing these correctly labelled `kind: 'middleware'` instead of either an
  unhandled rejection (non-shared) or a misleading `kind: 'abort'` (shared) —
  if you have middleware that can throw an `AbortError`-named failure
  unrelated to request cancellation. See #5 above: this is the same
  "throwing middleware now returns a Result" change, just for a failure that
  happens to be named like an abort.

- **Any abort of the exact signal handed to `fetch` — including one installed
  by middleware — is now `'abort'`/`'timeout'` and silent**, not classified by
  what was thrown. A middleware that replaces `ctx.request.signal` (e.g. a
  per-attempt timeout) and whose replacement signal aborts now gets the same
  cancellation treatment as any other abort on the operative signal.

**What to do, generally:** grep your `onError` handler and any code branching
on `error.kind` or `error.status === 0` for logic that assumed "not named
`AbortError`" meant "not a cancellation," or that assumed `kind ===
'middleware'` was reserved for genuine middleware bugs. Both assumptions are
now wrong in the specific ways above.

### 8. Cancelling during the response body download is now classified as the cancellation

Aborting after headers arrive but while the body is still downloading — a
component unmounting mid-fetch, a deadline firing mid-download — used to be
misclassified for a **non-2xx** response specifically. The **2xx** case
already produced the right `kind`/`status`/`response` shape in 2.2.1; only
whether it was *reported* changes there, which is entirely #6 (`onError` no
longer fires for `'abort'`), not a distinct shape change:

```ts
// A slow response body, aborted partway through download:
// 2xx response (e.g. a slow success payload):
//   2.x   → kind: 'abort' (or 'network', if the thrown value wasn't
//           name-recognisable as AbortError/TimeoutError), status: 0,
//           response: null — reported (2.2.1 had no abort suppression at all)
//   3.0.0 → kind: 'abort' (or 'timeout'), status: 0, response: null — not
//           reported (same shape, see #6 for why reporting stops)
// non-2xx response (e.g. a slow 502 gateway page) — this is the real shape change:
//   2.x   → kind: 'http', the real status, response present, body: null —
//           reported, regardless of whether the cancellation was ours
//   3.0.0 → kind: 'abort' (or 'timeout'), status: 0, response: null — not reported
```

Two concrete hazards to check for, both specific to the **non-2xx** case:

- **Code branching on `error.status` for a cancellation that lands while a
  non-2xx body downloads** now sees `status: 0` instead of the real status —
  the same "was this reported?" question as #6/#7 applies.
- **Code reading `result.response!.headers` (or any non-null assertion on
  `response`) for that same non-2xx-cancellation case** must now handle
  `response === null` — it previously had a real `response` (with `body:
  null`), even though the request never actually finished.

**Also:** `retryMiddleware`'s default `retryOn` (and any custom `retryOn`
keyed on `status >= 500`) no longer retries a cancellation caught in this
window, because `status` is now `0`, not the real (often 5xx-shaped) status.
This is strictly correct — retrying a cancellation you caused is never
useful — but it means **fewer requests** for code that happened to rely on
the old misclassification triggering a retry.

### 9. GraphQL partial data is preserved (additive)

A GraphQL response with both `data` and `errors` (partial success — a
nullable field errored while the rest of the query resolved) used to discard
`data` entirely. It's now available as `error.partialData`:

```ts
const { error } = await graphql.getCategory({ id: '123' })
if (error) {
  console.log(error.body)          // GraphQLError[]
  console.log(error.partialData)   // the data the server sent alongside the errors, or undefined
}
```

This lives on `error.partialData`, not `result.data` — putting it on `data`
would break the `Result` union's narrowing from #1: a non-null `error` means
`data` is null, and a null `error` means the call succeeded (see the
empty-body caveat below). Nothing to change unless you want to start using
it.

### Worth knowing, no action needed

- **A genuinely malformed body arriving while the signal *happens* to already
  be aborted is classified as the cancellation, and so dropped from
  `onError`**, even when the abort didn't actually cause the parse failure.
  The guard asks "is the signal aborted right now," not "did the abort cause
  this" — narrowing that further would require `parseResponse` to
  distinguish its own read failure from a parse failure across all five
  response types, which it doesn't attempt. In practice this only matters if
  you're relying on `onError` to catch every malformed-body case with
  certainty; it's a narrow, pre-existing edge case, not a new hazard to
  design around.
- **Middleware authors: do not attach `signal.reason` as `.cause` to your
  own, unrelated failure.** `throw new Error('cache write failed', { cause:
  ctx.request.signal.reason })` is read as *relaying* the library's own
  cancellation (see #7's `.cause`-unwrapping case) and silently dropped as
  `'abort'`, even though your error is about something else entirely (a cache
  write, not a cancellation) that merely happened to occur while the signal
  was aborted. Use a different field to carry that context —
  `{ cause: new Error('disk full') }`, or a custom property — and reserve
  `.cause` for genuine propagation of the signal's own reason.
- **`SuccessResult.data` is typed `TResponse`, not `TResponse | null` — but an
  empty body still parses to `null` at runtime.** A `DELETE` that answers
  `200` with no body (or a `204`) is one of the most common REST shapes, and
  `parseResponse` returns `null` for it exactly as it always has (see the
  `responseType` reference for the empty-body case). 3.0.0 removes the `| null`
  from the *type*, not from the *behaviour*: `error` is still `null` on that
  response, so `data` narrows to `TResponse` and compiles, but the value you
  get is `null` anyway.

  ```ts
  const deleteUser = new Request<{ id: string }, { deleted: boolean }>({
    method: 'DELETE', path: '/users/:id',
  })
  const { data, error } = await api.deleteUser({ id: '42' })
  if (error) return
  console.log(data.deleted) // throws: data is null at runtime for a 200/204 empty body
  ```

  If an endpoint can answer 204 or an empty 200, say so accurately in its own
  `TResponse`. **This guidance changed in 3.1.0:** at the time of the 3.0.0
  release, the only option was widening to `Request<{ id: string }, { deleted:
  boolean } | null>` and handling the `null` case explicitly; as of 3.1.0, use
  `responseType: 'none'` instead (see [Upgrading to
  3.1.0](#upgrading-to-310) above) — it's more accurate (declares "no body,"
  not "body or null") and it silences the empty-body warning 3.1.0 added. This
  is not a new *behaviour* (2.2.1 had the identical runtime `null`); what
  changed in 3.0.0 is that the type system no longer forces you to handle it,
  and what changed in 3.1.0 is the recommended way to handle it anyway.

### Nothing to do if…

…you only call API methods and check `error`, **and every endpoint's
`TResponse` accounts for its own empty-body responses** (see the bullet
above — as of 3.1.0, a `DELETE`/204/empty-200 endpoint should declare
`responseType: 'none'` to stay accurate; everything else needs no change):

```ts
const { data, error } = await api.getUser({ id: '42' })
if (error) {
  console.error(error.status, error.body)
  return
}
console.log(data.name)
```

The only change visible here is a good one: `data!.name` becomes `data.name`
(the `!` is now unnecessary and can be deleted, but leaving it is harmless —
a non-null assertion on an already-non-null value is a no-op). No behavior
changes for this pattern.

## Upgrading to 2.2.0

2.2.0 is additive — no API changed shape, and there is nothing you need to do.

### Worth knowing, no action needed

- **Abort reasons now survive `dedupe`.** Previously, a `dedupe: true`
  request's merged signal always aborted with a generic, reason-less
  `AbortError`, regardless of what actually caused the abort:

  ```ts
  const withTimeout: Middleware = async (ctx, next) => {
    ctx.request.signal = AbortSignal.timeout(20)
    return next()
  }

  const api = createApi({
    baseUrl: '/api',
    requests: { getUser }, // getUser has dedupe: true
    middleware: [withTimeout],
  })

  const { error } = await api.getUser({ id: '42' })
  // 2.1.0 → error.body.name === 'AbortError'   -- the real cause (a timeout) was lost
  // 2.2.0 → error.body.name === 'TimeoutError' -- the actual cause survives
  ```

  This only differs when `dedupe: true` is combined with a caller-supplied
  `signal` or a signal-setting middleware — plain `dedupe: true` with no
  external signal involved is unaffected. `error.body.name` (and any custom
  reason you pass to your own `AbortController.abort(reason)`) is a
  **pre-2.2.0 surface** — existing code reading it does not need to touch
  anything new to notice this, since it never had to opt into `kind` to read
  `.name` in the first place. Going forward, prefer branching on the new
  `error.kind` (`'timeout'` vs `'abort'` vs `'network'`) instead of
  `error.body.name` — it's the field the library commits to maintaining.

- **Retries now back off instead of firing instantly.** `retryMiddleware(3)`
  previously made all four attempts in the same tick, with no delay between
  them. It now waits out a real backoff (exponential by default, with jitter)
  between attempts, so a retrying request takes measurably longer in
  wall-clock terms. Nothing breaks, but a test asserting on elapsed time
  around a retrying call may need its tolerance revisited — or pass
  `retryMiddleware({ baseDelay: 0, jitter: false })` to keep the old, instant
  timing.

## Upgrading to 2.1.0

2.1.0 is a non-breaking release, but **two changes can surface as new errors** in
code that was already subtly wrong. Neither requires an API change on your side.

### The Node floor moved from 18 to 20

Node 18 reached end-of-life on 2025-04-30, and CI never tested it — the "Node 18+"
claim in the README was untested, which is worse than not making it. `package.json`
now declares `"engines": { "node": ">=20" }`.

**What to do:** if you are on Node 18, nothing breaks today — the library uses no
API that Node 18 lacks. But the version is unsupported and untested, so treat this
as notice rather than a guarantee.

### Path parameter mismatches now fail loudly

Previously, a mismatch between a request's params and its path template shipped a
malformed URL and said nothing:

```ts
const getUser = new Request<{ id: string }, User>({
  method: 'GET',
  path: '/users/:userId',   // note: :userId, but the param is `id`
})

await api.getUser({ id: '42' })
// 2.0.0 → GET /api/users/:userId?id=42   ← literal token, value duplicated as a query param
// 2.1.0 → Result with an error; no request is made
```

The 2.1.0 result is an ordinary error `Result`, not a thrown exception — the
never-throws contract is intact:

```ts
const { error } = await api.getUser({ id: '42' })
// error.status === 0
// String(error.body) === 'TypeError: Unresolved path parameter :userId in path "/users/:userId". …'
```

**What to do:** if this fires after upgrading, the endpoint was making a malformed
request all along. Align the param name with the path token (or vice versa). The
error message names the offending token and the path.

**Related:** `baseUrl` and `path` now join with exactly one slash, so a `baseUrl`
ending in `/` no longer produces `//`. If a server was tolerating (or redirecting)
the double slash, requests will now go to the correct URL — worth checking if you
have path-sensitive routing or logging.

### Worth knowing, no action needed

- `ctx.request.signal` is now readable and writable from middleware, which makes
  timeouts and cancel-on-condition writable in userland for the first time:

  ```ts
  const timeout = (ms: number): Middleware => async (ctx, next) => {
    ctx.request.signal = AbortSignal.timeout(ms)
    return next()
  }
  ```

  It composes with `dedupe: true` — dedupe merges whatever signal is current
  rather than discarding it.

- The published package is roughly half its former size (240.6 kB → 112.7 kB
  unpacked). Source maps were dropped: they referenced `../src/*.ts`, which was
  never published, and carried no `sourcesContent`, so they resolved to nothing
  in every consumer. JSDoc still ships in the `.d.ts` files, so editor hover
  documentation is unchanged.
