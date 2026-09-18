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
import type { RequestConfig, ResponseType, StandardSchemaV1, InferOutput } from './types.js'

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
 * A missing leading slash is normalised before anchoring. `buildUrl` requires a
 * token to sit at index 0 of a `split('/')` segment, which means "preceded by
 * `/`, **or at the very start of the string**" — and segment 0 always starts at
 * index 0. Prepending `/` when it is absent makes this type's `/:` requirement
 * exactly equivalent to that condition, and is a no-op for a path that already
 * has one.
 *
 * 4.1.0 shipped the anchor without the normalisation and so under-inferred a
 * path whose token *starts the string*: `':id'` inferred nothing while the
 * request still demanded `id`, failing at runtime. A path like `'users/:id'`
 * was never affected — it contains a literal `/:`.
 *
 * Exported for `tests/types.test-d.ts`. Not re-exported from `src/index.ts`, so
 * it is not public API — see index.ts's note on what is deliberately withheld.
 */
type Anchored<P extends string> =
  P extends `${string}/:${infer Tail}`
    ? TakeName<Tail> extends infer Name extends string
      ? Name extends ''
        ? Anchored<Tail>
        : { [K in Name]: string | number } &
          (Tail extends `${Name}${infer Rest}` ? Anchored<Rest> : {})
      : {}
    : {}

export type PathParams<P extends string> = Anchored<P extends `/${string}` ? P : `/${P}`>

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
 * The response type a schema supplies, or `unknown` when it supplies none.
 *
 * "Supplies none" covers two cases that must be treated identically: `TSchema`
 * is literally `undefined` (no `schema` was written), and `TSchema` is present
 * but its OUTPUT is `unknown` or `any` (a widened `StandardSchemaV1<unknown>`,
 * which is what a bare `RequestConfig`-typed variable's `schema` field infers
 * as — see `SchemaConflictGuard`). Both collapse to `unknown` here, which is
 * what lets `SchemaConflictGuard` and `defineRequest`'s return type ask the
 * SAME question ("did a schema meaningfully narrow the response?") and get the
 * same answer. They used to ask it separately and disagreed: the guard read
 * `TSchema`'s presence while the return type read `InferOutput<TSchema>`
 * directly, so a widened config passed the guard (no schema "given") but the
 * return type still took the `InferOutput` branch and produced `unknown` —
 * silently discarding an explicit `TResponse`. One shared rule, asked once.
 */
type SchemaOut<TSchema> = [TSchema] extends [undefined] ? unknown : InferOutput<TSchema>

/**
 * Refuses a schema and an explicit response type together.
 *
 * Two sources of truth that can disagree is a mistake, and this project makes a
 * contradiction unrepresentable rather than picking a winner silently — the same
 * reasoning as the `share` + `dedupe` throw and the empty-body guard.
 *
 * It fires even when the two AGREE, because the failure it prevents is temporal:
 * the schema changes, the explicit type is now wrong, and nothing reports it
 * because it was never being read.
 *
 * `unknown extends TResponse` is true only when no explicit argument was given,
 * which is what makes "was one supplied?" answerable at all. `any` satisfies it
 * too and counts as "not given" — acceptable, since `defineRequest<any>()` is
 * already opting out of everything.
 *
 * The "was a schema given?" side reads `SchemaOut<TSchema>` — the schema's
 * OUTPUT — rather than asking whether `TSchema` itself is `undefined`, and the
 * config field feeding it is `Omit<RequestConfig, 'schema'> & { schema?:
 * TSchema }` rather than `RequestConfig & { schema?: TSchema }`. Both changes
 * exist for the same reason: `RequestConfig` already declares `schema?:
 * StandardSchemaV1<unknown>` (for `new Request`), so a config typed as plain
 * `RequestConfig` — or a spread of one — structurally carries that field
 * whether or not a schema was actually written. Left in the intersection, that
 * field becomes a second, competing inference source for `TSchema`, and —
 * only when `TSchema` also appears inside a conditional in the SAME parameter,
 * which is what a "was one given?" guard requires — TypeScript stops
 * decomposing a non-literal argument (a bare `RequestConfig`-typed variable)
 * property by property and falls back to `TSchema`'s default instead, which
 * then disagrees with the very shape it just failed to read. `Omit` removes
 * the competing source; reading the OUTPUT instead of `TSchema` itself
 * survives whatever that source infers anyway, because an unknown-output
 * schema (the widened `StandardSchemaV1<unknown>`, same as a plain
 * `undefined`) reads as "not given" right alongside the real absence.
 *
 * A schema carrying no type information — an OUTPUT of `unknown` or `any` —
 * is treated as no schema at all: the explicit response type is HONOURED, and
 * no conflict is raised. `defineRequest<User>()({ ..., schema:
 * looselyTypedSchema })` compiles and its `data` is `User`, not `unknown`.
 * This is not a gap being tolerated; it is what makes a widened
 * `RequestConfig`-typed config work at all — a spread of one carries exactly
 * `schema?: StandardSchemaV1<unknown>`, inherited from `RequestConfig` itself,
 * and a schema written directly can be just as loosely typed. A schema that
 * DOES carry type information — a concrete `Output` — supplies the response
 * type instead (see `defineRequest`'s return-type expression), and an
 * explicit type alongside THAT is the conflict this guard exists to catch.
 *
 * This falls out of `SchemaOut` for free, and only BECAUSE the guard and
 * `defineRequest`'s return type read it identically. That took two attempts:
 * moving the guard onto `SchemaOut` (the OUTPUT paragraph above) fixed the
 * guard's own over-rejection of widened configs, but the return type was left
 * reading `[TSchema] extends [undefined]` directly — the schema's PRESENCE,
 * not its output — so a widened config now passed the guard while the return
 * type still discarded its `TResponse`. Same mistake as the original
 * over-rejection, just relocated: two formulas answering one question. Both
 * disappeared once both sites read `SchemaOut`. Do not let them drift apart
 * again: change `SchemaConflictGuard` and `defineRequest`'s return-type
 * expression together, and reverify against `tests/types.test-d.ts`'s
 * widened-config assertions, which check the resulting `data` type via
 * `createApi` rather than merely that the call compiles — editing one site
 * without the other, unverified, is exactly how this regressed.
 */
type SchemaConflictGuard<TSchema, TResponse> =
  unknown extends SchemaOut<TSchema>
    ? unknown
    : unknown extends TResponse
      ? unknown
      : { __schemaSuppliesTheType: 'omit the explicit response type when passing a schema' }

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
export function defineRequest<TResponse = unknown, TExtra extends object = {}>() {
  return <TPath extends string, TRT extends ResponseType | undefined,
          TSchema extends StandardSchemaV1<any> | undefined = undefined>(
    config: Omit<RequestConfig, 'schema'> & { path: TPath; responseType?: TRT; schema?: TSchema }
      & EmptyBodyGuard<TRT, TResponse>
      & SchemaConflictGuard<TSchema, TResponse>
  ): Request<Id<PathParams<TPath> & TExtra>, unknown extends SchemaOut<TSchema> ? TResponse : SchemaOut<TSchema>> =>
    new Request<Id<PathParams<TPath> & TExtra>, unknown extends SchemaOut<TSchema> ? TResponse : SchemaOut<TSchema>>(config)
}
