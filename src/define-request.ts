// =============================================================================
// define-request.ts — a typed factory for Request definitions
// =============================================================================
//
// `new Request<TParams, TResponse>(config)` makes you restate what the path
// already says: `/users/:id` plus `{ id: string }`. Nothing checks one against
// the other, so `api.getUser({ userId: '42' })` compiles, buildUrl finds no
// `:userId` to substitute, `:id` survives, and buildUrl throws at runtime.
//
// A class constructor cannot fix that. Beyond TS1092, TypeScript has no partial
// type-argument inference: the moment a caller writes `new Request<P, R>(...)`
// explicitly, nothing else in that call can be inferred. A generic FUNCTION can
// read the `path` literal, which is what this file is.
// =============================================================================

import { Request } from './request.js'
import type { RequestConfig, ResponseType } from './types.js'

/**
 * The characters a path token name may contain.
 *
 * This list is not arbitrary and must not be "simplified": it mirrors
 * `buildUrl`'s substitution pattern, `:${key}(?=[^a-zA-Z0-9_]|$)`
 * (src/utils/path-params.ts). If the two ever disagree, the types describe a
 * URL the runtime does not build.
 */
type WordChar =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '_'

/**
 * Consumes the leading word characters of `S` — a token name — and stops at the
 * first character that is not one, exactly where `buildUrl`'s lookahead stops.
 *
 * Character-at-a-time rather than splitting on '/', because a token does not
 * have to end at a slash: `/users/:id.json` substitutes `:id` and leaves
 * `.json`, and `/search/:q?x=1` substitutes `:q`.
 */
type TakeName<S extends string, Acc extends string = ''> =
  S extends `${infer C}${infer Rest}`
    ? C extends WordChar ? TakeName<Rest, `${Acc}${C}`> : Acc
    : Acc

/**
 * The params a path template requires, as `{ token: string | number }`.
 *
 * `string | number` because `buildUrl` does `encodeURIComponent(String(value))`
 * — a numeric id is as valid as a string one. An object is rejected, which is
 * right: `String({})` is `"[object Object]"`, a silently wrong URL.
 *
 * A path with no tokens gives `{}`, and `Record<string, never> extends {}`
 * holds, so `ApiMethod`'s optional-params branch still fires and `api.health()`
 * stays callable with no arguments.
 *
 * A token must BEGIN a path segment, mirroring `buildUrl`'s Phase 1b
 * (src/utils/path-params.ts, search "A token must BEGIN a path segment"):
 * matching is anchored to `/:` rather than a bare `:`, so a colon that appears
 * mid-segment — a Google-style custom method like `/v1/documents:batchGet`,
 * or a time like `/events/at/12:30` — is never mistaken for a token. Both of
 * those paths parse to `{}`, not `{ batchGet: ... }` or `{ '30': ... }`.
 *
 * Exported for `tests/types.test-d.ts`. Not re-exported from `src/index.ts`, so
 * it is not public API — see index.ts's note on what is deliberately withheld.
 */
export type PathParams<P extends string> =
  P extends `${string}/:${infer Tail}`
    ? TakeName<Tail> extends infer Name extends string
      ? Name extends ''
        ? PathParams<Tail>
        : { [K in Name]: string | number } &
          (Tail extends `${Name}${infer Rest}` ? PathParams<Rest> : {})
      : {}
    : {}

/**
 * Flattens an intersection into a single object type.
 *
 * Presentational, but load-bearing for the feature's value: without it, hovering
 * an endpoint in an editor shows `PathParams<'/orgs/:org/repos'> & { page?:
 * number }` instead of `{ org: string | number; page?: number }`.
 */
export type Id<T> = { [K in keyof T]: T[K] } & {}

/**
 * Rejects `responseType: 'none'` when `TResponse` is a real type.
 *
 * `'none'` means the endpoint sends no body on success and `data` is
 * `undefined` at runtime. Declaring a response type alongside it is a
 * contradiction that was, until now, only a documented convention.
 *
 * Fires only on the LITERAL `'none'`. A config whose `responseType` is the
 * widened `ResponseType | undefined` — a `RequestConfig`-typed variable, or a
 * spread of one — infers as the whole union, which is not `'none'`, and passes
 * through untouched. That matters: constraining the config parameter directly
 * rejects both of those legitimate forms, which is exactly the permissiveness
 * problem recorded in `ResponseType`'s JSDoc in types.ts.
 *
 * The other side of "literal only" is `TResponse`, not `TRT`: the check is
 * `undefined extends TResponse`, so any `TResponse` that ADMITS `undefined` —
 * `User | undefined`, `any`, `unknown` — satisfies the guard and is not
 * rejected, same as the exact type `undefined`. Only a `TResponse` that
 * excludes `undefined` entirely trips it.
 *
 * The failure branch uses a non-colliding marker property, `__emptyBodyMismatch`,
 * rather than reusing `responseType`. Reusing `responseType` collapses that
 * property's type to `never` via intersection with the existing `responseType?:
 * TRT`, which TypeScript then reports as a per-property mismatch on unrelated
 * fields like `method`, never mentioning the message. `__emptyBodyMismatch`
 * collides with nothing a real config has, so TypeScript instead reports it as
 * a missing required property, and the sentence rides along in that message.
 */
type EmptyBodyGuard<TRT, TResponse> =
  [TRT] extends ['none']
    ? undefined extends TResponse
      ? unknown
      : { __emptyBodyMismatch: 'declare TResponse as undefined when responseType is none' }
    : unknown

/**
 * Declares an endpoint, inferring its path parameters from the `path` literal.
 *
 * Curried because TypeScript has no partial type-argument inference: supplying
 * `TResponse` and the config in ONE call makes `TPath` fall back to its
 * constraint, `PathParams<string>` resolve to `{}`, and `{}` accepts anything —
 * the feature disappears with no error anywhere, which is precisely how the
 * 3.1.0 guard attempt failed. Two calls keep the response type explicit and the
 * path inferred.
 *
 * `TExtra` is for params the path does not name — query or body fields.
 *
 * Returns an ordinary `Request`, so `createApi` needs no knowledge of this
 * function: its `ExtractParams`/`ExtractResponse` already match structurally.
 * `new Request(...)` remains and is not deprecated; this is a second way to
 * construct, which is what makes it additive.
 *
 * @example
 * ```ts
 * const getUser = defineRequest<User>()({ method: 'GET', path: '/users/:id' })
 * const listRepos = defineRequest<Repo[], { page?: number }>()({
 *   method: 'GET',
 *   path: '/orgs/:org/repos',
 * })
 *
 * api.getUser({ id: '42' })               // ✓
 * api.getUser({ userId: '42' })           // ✗ compile error
 * api.listRepos({ org: 'acme', page: 2 }) // ✓
 * ```
 */
export function defineRequest<TResponse, TExtra extends object = {}>() {
  return <TPath extends string, TRT extends ResponseType | undefined>(
    config: RequestConfig & { path: TPath; responseType?: TRT } & EmptyBodyGuard<TRT, TResponse>
  ): Request<Id<PathParams<TPath> & TExtra>, TResponse> =>
    new Request<Id<PathParams<TPath> & TExtra>, TResponse>(config)
}
