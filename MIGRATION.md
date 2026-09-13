# Migration Guide

Upgrade notes for `@iremlopsum/apify`. Only releases that need action appear
here — if a version isn't listed, upgrading to it requires no changes.

For the full record of what changed in each release, see [CHANGELOG.md](./CHANGELOG.md).

---

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
