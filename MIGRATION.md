# Migration Guide

Upgrade notes for `@iremlopsum/apify`. Only releases that need action appear
here — if a version isn't listed, upgrading to it requires no changes.

For the full record of what changed in each release, see [CHANGELOG.md](./CHANGELOG.md).

---

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
