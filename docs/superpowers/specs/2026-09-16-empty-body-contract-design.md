# Empty response bodies, and the last untested guard — Design

**Date:** 2026-09-16
**Status:** approved, ready for planning
**Ships as:** 3.1.0 (additive) then 4.0.0 (the break)

---

## Goal

Make `SuccessResult.data: TResponse` true, and pin the one guard 3.0.0 shipped with no test.

## Why now

3.0.0 made `Result<T>` a discriminated union so that checking `error` narrows `data`. The whole-branch review found the claim is false for one shape:

```
DELETE /users/7  ->  204 No Content
r.error === null   r.data === null
```

`parseResponse` produces that `null` itself (`const text = await response.text(); return text ? JSON.parse(text) : null`), and 3.0.0 then removed the `TResponse | null` that had been forcing consumers to check — **and told them, in three places, to delete the check**. In 2.2.1 `console.log(data.deleted)` did not compile without `data!`. In 3.0.0 it compiles clean and throws at runtime.

3.0.0 shipped documentation as the mitigation. That only protects readers who find the caveat, which is the wrong half of the audience: the people most at risk are the ones who upgrade on the changelog headline.

Separately, the review found three guards with no behavioural coverage. Two were pinned before 3.0.0 shipped. The third — the shared-signal re-merge — is still open: deleting its three lines leaves the suite fully green, yet without it a `share: true` request with a signal-replacing middleware keeps retrying in the background after every caller has resolved (measured: 47 fetches against an expected 3).

## Scope

- **3.1.0** — `responseType: 'none'`; empty-body detection plus a one-time warning; the shared-signal re-merge test; docs.
- **4.0.0** — an empty JSON body becomes an error.

## Non-goals

- The other parked 3.0.0 items: the templated `error.request.url` on `'middleware'`/setup-error paths, and six comments left stale by Task 10. Real, unrelated, and folding them in would make this release about three things.
- Any further strictness. **4.0.0's scope is one seam flip.** If it grows, re-brainstorm rather than let a major accumulate passengers.

## Decisions already made

Settled during brainstorming. Do not relitigate without new information.

| Decision | Rationale |
|---|---|
| An empty body on `responseType: 'json'` is an **error**, not `null` | You declared JSON; the server sent none. Makes `data: TResponse` true rather than documented-as-false |
| **No special case for 204** | One rule — declared JSON, got no JSON — beats status-dependent behaviour. A 204 endpoint declares `responseType: 'none'`, which is more accurate anyway |
| Ship in **two releases**, tool before rule | Consumers can declare their empty endpoints while still on 3.x, so 4.0.0 is a no-op for anyone who prepared. You cannot tell people to use a feature that does not exist yet |
| 3.1.0 warns via **one-time `console.warn` per request name** | Reaches people who do not read changelogs, which is most of them, and names the exact `Request` to change |
| Detection lands in **3.1.0**, not 4.0.0 | If the detection is wrong, it surfaces in the additive release rather than the breaking one |

## Global constraints

- **Zero runtime dependencies.**
- **Never throws.** Every public entry point returns a `Result`; only `createApi` may throw, at construction. The new warning must not violate this — it is guarded and wrapped, on the same reasoning as `fireOnError`.
- **Pure ESM**, `.js` extensions on internal imports.
- **Runtime-agnostic.** Nothing above the `node >= 20` floor. `AbortSignal.any` and regex lookbehind remain banned. `console` is guarded, following the precedent that `logMiddleware` uses `Date.now()` rather than `performance`.
- `src/index.ts` exports no utils or internals.
- Test commands: `npm run typecheck`, `npm run test:types`, `npm run test:run`, `npm run test:integration`.
- **Revert-verify every new test** against its own named broken variant. Four tests during 3.0.0 were caught passing against the exact bug they were written for; three of those were caught by implementers auditing their own work.

---

## Section 1 — `responseType: 'none'` and the rule

`ResponseType` gains `'none'`, meaning *this endpoint returns no body*:

```ts
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'none'
```

`parseResponse` returns `undefined` for it. It does not parse the body, and cancels the response stream so a keep-alive connection is released rather than left dangling — guarded, since cancelling an already-consumed or absent stream can throw and a cleanup step must not fail a request.

A server that sends a body anyway is not an error: `'none'` means *the caller does not want a body*, so the content is discarded. The rule below applies to `json`, not to `'none'`.

The rule applies to `json` only:

| response | 3.1.0 | 4.0.0 |
|---|---|---|
| `json`, body present | parsed data | parsed data |
| `json`, empty body (any status, including 204) | `data: null` + one-time warning | `ApiError { kind: 'parse', status }` |
| `none` | `data: undefined` | `data: undefined` |
| `text`, empty | `''` | `''` |
| `blob` / `arrayBuffer`, empty | empty value | empty value |

`text`, `blob` and `arrayBuffer` already produce legitimate empty values and are untouched. `formData` already throws on an empty body; that now routes through the same `'parse'` classification rather than being special-cased.

### The type-level guard

Declaring `responseType: 'none'` while typing `Request<P, User>` would put `data: undefined` behind a `User` — the same class of lie being fixed. Enforcing `TResponse = undefined` when `responseType: 'none'` requires a constructor overload on `Request`; `RequestConfig` is not generic today, so this is not a one-liner.

**Prototype this first.** If the enforcement costs more than it returns, fall back to documenting the convention and say so explicitly in the plan — do not discover the cost late and quietly drop it.

## Section 2 — Detection, and why `data === null` cannot be the trigger

`JSON.parse("null")` is `null`. A server sending the body `null` is indistinguishable from one sending nothing, and erroring on the former would be wrong: `null` is valid JSON.

`parseResponse` therefore reports emptiness distinctly, via a module-level sentinel matching the `ABANDONED` symbol the share tracker already uses. It stays internal to `src/create-api.ts` — nothing new reaches the barrel:

```
parseResponse   json + ""      -> EMPTY_JSON_BODY
                json + "null"  -> null            (a real body)
```

The success path decides, and this is the **only** place the two releases differ:

```ts
// 3.1.0
if (data === EMPTY_JSON_BODY) { warnOnce(name); data = null }

// 4.0.0
if (data === EMPTY_JSON_BODY) return parseError(response, 'empty response body')
```

One seam, a two-line diff between releases, rather than the rule smeared across the parse path.

### The warning

A `Set<string>` of already-warned request names, living per `createApi` call alongside `dedupeTracker` and `shareTracker` — same lifetime convention, so two API instances warn independently and nothing leaks globally.

Guarded (`typeof console?.warn === 'function'`) and wrapped in `try`/`catch`: a diagnostic must never fail a request. Declaring `responseType: 'none'` silences it, because that is the fix.

Message names the request and the remedy:

```
[apify] deleteUser: server returned an empty body for responseType 'json'.
This yields data: null today and will be an error in 4.0.0. Declare
responseType: 'none' if the endpoint returns no content.
```

**Tests:** warns once across repeated calls to one request; warns separately per request name; silent for `responseType: 'none'`; silent for a literal `null` body; and does not throw when `console.warn` itself throws.

## Section 3 — The shared-signal re-merge test

The measured symptom is 47 background fetches against an expected 3, but **counting fetches over time is the wrong assertion** — it needs a sleep and can flake, which is the class of test this codebase has already been burned by.

Assert the state instead: did the shared controller's abort actually reach `fetch`? The mock registers an abort listener and sets a flag.

```
share: true, a middleware replacing ctx.request.signal (the perAttempt pattern
the library documents), retryMiddleware in the chain, two sharers, both give up.

with the re-merge      -> fetchAborted === true
with it reverted       -> fetchAborted === false
```

No waiting, no sleep, one point of failure. Goes in `tests/share.test.ts`, revert-verified against deleting the three lines — which is the whole point, since the suite currently passes without them.

This closes the last of the three unpinned guards the 3.0.0 whole-branch review found.

## Documentation

3.0.0's "Worth knowing" caveat tells readers to write `TResponse | null` for empty-body endpoints. In 3.1.0 that advice is **superseded** — the fix becomes `responseType: 'none'`. Update that passage rather than leaving it to contradict the new guidance; contradictory documentation across releases is the exact failure the 3.0.0 review kept finding.

- **3.1.0:** `responseType` reference gains `'none'`; a short `MIGRATION.md` "Upgrading to 3.1.0" (no action required; what the warning means and how to silence it); CHANGELOG.
- **4.0.0:** `MIGRATION.md` entry stating what changes and that `responseType: 'none'` has been available since 3.1.0.

## Testing strategy

- **Revert-verify every new test** against its own named broken variant, recording both transcripts.
- **Type tests** asserting `responseType: 'none'` yields `data: undefined`, and that the union still narrows for ordinary requests.
- **A real-server integration test** using a genuine 204 from `tests/integration/server.ts`, which already accepts new endpoints. Mocked `fetch` got this case wrong before; a real server is the check that counts.
- Current green baseline: typecheck clean, 334 type, 296 unit (322 including integration), 26 integration.

## Sequencing

1. `responseType: 'none'` + the type-level guard prototype.
2. `EMPTY_JSON_BODY` detection + the one-time warning.
3. The shared-signal re-merge test.
4. Docs and the 3.1.0 release.
5. **4.0.0, separately:** flip the seam, delete the warning, migration entry.

Steps 1-4 are one plan. Step 5 is its own, after 3.1.0 has been out long enough to be worth having shipped.

### What persists, and what is transitional

Only one of the three things 3.1.0 introduces is removed in 4.0.0. Stated explicitly because "delete the warning" has already been misread once as tearing out the whole mechanism:

| introduced in 3.1.0 | fate in 4.0.0 | why |
|---|---|---|
| `responseType: 'none'` | **permanent** | It is the actual fix, and the thing 4.0.0's migration guide points consumers at. Removing it would leave them nowhere to go |
| `EMPTY_JSON_BODY` detection | **permanent** | 4.0.0's error is built on it; the seam flip changes what is done with it, not whether it is detected |
| the one-time `console.warn` | **deleted** | Its success condition is being removed. Surviving into 4.0.0 would mean warning about something that already throws |

### Why 4.0.0 and not a minor

The change turns a success into a failure: a `json` request against a 204 endpoint goes from `{ data: null, error: null }` to `{ data: null, error: ApiError }`, so consumer code that currently falls through `if (error) return` starts returning early.

The deciding factor is the caret range, not the label. Anyone on `^3.0.0` picks up a `3.2.0` **automatically** — an install on a Tuesday, CI still green because their tests mock `fetch`, and their DELETE endpoints fail in production without anyone having chosen it or read anything. A major keeps them on 3.x until they deliberately upgrade, which is when they read the migration guide.

That gate is also what makes 3.1.0's warning worth building: it exists to reach people who do not read changelogs, and it only pays off if there is a step between *you were warned* and *you are broken*.
