import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from './result.js'
import { composeMiddleware } from './middleware.js'
import { DedupeTracker } from './utils/dedupe.js'
import { mergeHeaders } from './utils/headers.js'
import { abortKind, propagatesReason } from './utils/abort-kind.js'
import { resolveBudget } from './utils/budget.js'
import type { CallOptions, ErrorResult, Middleware, MiddlewareContext, Result, GraphQLBaseConfig, OperationConfig, GraphQLError } from './types.js'

// ---------------------------------------------------------------------------
// Operation — typed config container for GraphQL operations
// ---------------------------------------------------------------------------

export class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  // phantom fields — never assigned; exist only so TypeScript can infer TVariables/TData
  // from conditional types in createGraphQL (e.g. `T extends Operation<infer V, infer D>`)
  declare readonly _variables: TVariables
  declare readonly _data: TData
  constructor(config: OperationConfig) {
    this.config = config
  }
}

// ---------------------------------------------------------------------------
// gql — tagged template literal for editor tooling support
// ---------------------------------------------------------------------------

export const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)

// ---------------------------------------------------------------------------
// Internal type helpers
// ---------------------------------------------------------------------------

type GraphQLMethod<TVariables extends object, TData> =
  Record<string, never> extends TVariables
    ? (variables?: TVariables, options?: CallOptions) => Promise<Result<TData>>
    : (variables: TVariables, options?: CallOptions) => Promise<Result<TData>>

type FlatClient<TOperations> = {
  [K in keyof TOperations]: TOperations[K] extends Operation<infer V, infer D>
    ? GraphQLMethod<V, D>
    : never
}

type SplitClient<TQ, TM> =
  (TQ extends Record<string, Operation<any, any>> ? { query: FlatClient<TQ> } : {}) &
  (TM extends Record<string, Operation<any, any>> ? { mutation: FlatClient<TM> } : {})

type WithOperations<T> = GraphQLBaseConfig & {
  operations: T
  queries?: never
  mutations?: never
}

type WithSplit<TQ, TM> = GraphQLBaseConfig & {
  operations?: never
  queries?: TQ
  mutations?: TM
}

// ---------------------------------------------------------------------------
// createGraphQL — overloaded factory
// ---------------------------------------------------------------------------

export function createGraphQL<T extends Record<string, Operation<any, any>>>(
  config: WithOperations<T>
): FlatClient<T>
export function createGraphQL<
  TQ extends Record<string, Operation<any, any>>,
  TM extends Record<string, Operation<any, any>>
>(config: WithSplit<TQ, TM>): SplitClient<TQ, TM>
export function createGraphQL(config: any): any {
  const {
    endpoint,
    middleware: globalMiddleware = [],
    headers: globalHeaders,
    onError,
  } = config

  const dedupeTracker = new DedupeTracker()

  /**
   * Calls the consumer's `onError`, swallowing anything it throws.
   *
   * `onError` runs *after* the result is in hand, so an exception from it
   * would reject a promise that already holds a perfectly good `Result` — the
   * caller would see a throw for an operation that merely came back with
   * GraphQL errors. A Sentry client in a misconfigured environment, or a
   * logger dereferencing `error.response.status`, is all it takes. Same stance
   * as the retry policy's user callbacks in `built-in-middleware.ts`.
   */
  const fireOnError = (error: ApiError): void => {
    // Aborts are cancellations we caused — a caller's own signal, or a newer
    // request superseding this one under dedupe. Reporting them to an error
    // tracker is noise. Timeouts are deliberately NOT suppressed: a deadline
    // you missed is a genuine failure, which is why the two kinds are separate.
    if (error.kind === 'abort') return
    if (!onError) return
    try {
      onError(error)
    } catch {
      /* swallowed by contract — onError cannot fail an operation */
    }
  }

  function buildMethod(name: string, operation: Operation<any, any>) {
    return (variables: object = {}, options: CallOptions = {}): Promise<Result<unknown>> => {
      const execute = (): Promise<Result<unknown>> => {
        /**
         * `create-api.ts`'s local equivalent, for the same reason: a Result
         * for a failure that never reached (or never came back from) `core()`,
         * construction only, no reporting — the `.then` hook below is what
         * reports, once, so this must not report a second time.
         *
         * Classification is by provenance, not by sniffing `reason`'s shape —
         * see `syntheticResult`'s doc in `create-api.ts` for the full
         * rationale. In short: if `signal` — the AbortSignal that actually
         * governs this operation — is the one that aborted, this failure IS
         * that cancellation, whatever shape `reason` takes. The only fallback
         * this function is ever called with is `'middleware'`, so the
         * propagation check (`propagatesReason` — identity, or one level of
         * `.cause`) always applies here: a middleware throwing its own
         * `AbortError`-named failure, unrelated to this operation's own
         * signal, must stay `'middleware'`.
         */
        function buildFailedResult(
          reason: unknown,
          signal: AbortSignal | undefined,
          fallbackKind: 'abort' | 'network' | 'middleware'
        ): ErrorResult<unknown> {
          const isOurCancellation =
            signal?.aborted === true &&
            (fallbackKind !== 'middleware' || propagatesReason(reason, signal.reason))
          const kind = isOurCancellation ? (abortKind(signal!.reason) ?? 'abort') : fallbackKind
          const error = new ApiError({
            kind,
            status: 0,
            statusText: '',
            body: reason,
            headers: new Headers(),
            request: { method: 'POST', url: endpoint, params: variables },
          })
          return createNetworkErrorResult(error, execute)
        }

        try {
          const allMiddleware: Middleware[] = [
            ...globalMiddleware,
            ...(operation.config.middleware ?? []),
            ...(options.middleware ?? []),
          ]

          // The caller's signal is the starting point, and it is what the
          // context carries into the middleware chain. When dedupe is enabled
          // the real registration happens inside core() — see below — so that
          // a middleware which short-circuits (a cache hit) never cancels a
          // live request that is genuinely in flight, and so that a signal
          // installed by middleware is an input to dedupe rather than
          // something dedupe overwrites.
          //
          // dedupeController doubles as the "already registered" flag: it is
          // set on the first attempt that reaches core() and survives across
          // retries, which keeps registration once per execute().
          // Resolve the deadline: per-call beats per-operation, and non-positive
          // means none. The signal is created once here — not inside core() —
          // so a retry sequence draws from a single budget rather than getting
          // a fresh one per attempt.
          //
          // GraphQL never coalesces, so the operation's deadline and this
          // caller's patience are the same signal — both budget fields are
          // identical and either may be read.
          const budget = resolveBudget(options.timeout, operation.config.timeout, options.signal, false)
          const callerSignal: AbortSignal | undefined = budget.operation
          let dedupeController: AbortController | undefined

          const core = async (ctx: MiddlewareContext): Promise<Result<unknown>> => {
            try {
              // Register with the dedupe tracker on the first attempt that
              // reaches core() — we are committed to sending a request. Any
              // middleware that short-circuits above us returned without
              // reaching this point, so it cannot cancel a live request.
              //
              // The `!dedupeController` guard makes this once per execute(),
              // not once per attempt. retryMiddleware calls next() repeatedly;
              // if every attempt re-registered, an older operation's retry
              // would abort a newer call for the same operation — the exact
              // inverse of dedupe's newest-wins contract.
              //
              // The signal we hand to track() is ctx.request.signal, not the
              // caller's: a middleware may have installed its own (a timeout,
              // a deadline), and dedupe must merge that rather than discard
              // it. Because registration happens only once, that field still
              // holds a live signal here — never a previous attempt's already
              // aborted dedupe signal.
              if (operation.config.dedupe && !dedupeController) {
                const tracked = dedupeTracker.track(name, ctx.request.signal ?? callerSignal)
                dedupeController = tracked.controller
                ctx.request.signal = tracked.signal
              }

              const response = await fetch(ctx.request.url, {
                method: 'POST',
                headers: ctx.request.headers,
                body: ctx.request.body as string,
                signal: ctx.request.signal,
              })

              if (!response.ok) {
                // `response.text()` is the network body read, not just
                // parsing, so an abort landing while an ERROR body downloads
                // must not be misreported as a genuine 'http' error with a
                // null body — the classification would otherwise be decided
                // by the server's status code rather than by what actually
                // happened. This is the same provenance concern the outer
                // `catch (err)` below already handles for the fetch() call
                // itself — NOT the success path's `JSON.parse` try further
                // down, which deliberately keeps its own `response.text()`
                // outside that try specifically so an abort during ITS
                // network read falls through to that same outer catch
                // instead of needing its own guard. The rationale for that
                // split is written up in full in create-api.ts, on the
                // identical `data`/success-path guard there (the comment
                // beginning "But `parseResponse` doesn't just parse"); it is
                // not repeated per call site in this file. A test pins this
                // exact behaviour below — see "abort during a success-body
                // download".
                let body: unknown
                try {
                  const text = await response.text()
                  body = text ? JSON.parse(text) : null
                } catch (parseErr) {
                  const signal = ctx.request.signal
                  // Same "aborted now, not necessarily caused by" limitation
                  // as the outer `catch (err)` below shares — checking
                  // `signal.aborted` at the moment of the catch, not
                  // causation. See create-api.ts's equivalent guards for the
                  // fuller writeup; not repeated per call site in this file.
                  if (signal?.aborted === true) {
                    const error = new ApiError({
                      status: 0,
                      kind: abortKind(signal.reason) ?? 'abort',
                      statusText: '',
                      body: parseErr,
                      headers: new Headers(),
                      request: { method: 'POST', url: ctx.request.url, params: variables },
                    })
                    return createNetworkErrorResult(error, execute)
                  }
                  body = null
                }
                const error = new ApiError({
                  status: response.status,
                  kind: 'http',
                  statusText: response.statusText,
                  body,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              // Parse in its own try so a malformed body is reported as what it
              // is: the server responded, we could not read it. Falling through
              // to the network catch would report status 0 and discard the
              // Response, telling the caller they are offline when they are not.
              const text = await response.text()
              let gqlBody: { data?: unknown; errors?: GraphQLError[] } | null
              try {
                gqlBody = text
                  ? (JSON.parse(text) as { data?: unknown; errors?: GraphQLError[] })
                  : null
              } catch (parseErr) {
                const error = new ApiError({
                  kind: 'parse',
                  status: response.status,
                  statusText: response.statusText,
                  body: parseErr,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              if (gqlBody?.errors?.length) {
                const error = new ApiError({
                  status: 200,
                  kind: 'http',
                  statusText: 'GraphQL Error',
                  body: gqlBody.errors,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                  partialData: gqlBody.data ?? undefined,
                })
                return createErrorResult(error, response, execute)
              }

              // A GraphQL success must carry data. `?? null` used to paper
              // over two different protocol violations here — an empty body
              // (gqlBody is null), and a well-formed {} or {"data": null}
              // with no errors — both surfacing as a success with data: null
              // behind a non-null TData. Since 4.0.0 both are reported.
              //
              // `"data": null` IS legitimate for a field error, but only
              // alongside `errors`, and the branch directly above already
              // routes that to an error Result carrying partialData. Control
              // only reaches here when the server reported no errors at all.
              //
              // Optional chaining also catches a non-object root (`42`,
              // `null`, `[1,2]` — all valid JSON): the GraphQL over HTTP spec
              // requires a map, so those are violations too.
              //
              // error.body is the raw response text, not a thrown exception —
              // nothing threw. It is the only useful answer to "then what did
              // the server send?".
              if (gqlBody?.data == null) {
                const error = new ApiError({
                  kind: 'parse',
                  status: response.status,
                  statusText: response.statusText,
                  body: text,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              return createSuccessResult(gqlBody.data, response, execute)
            } catch (err) {
              // Provenance over name-sniffing: if the signal we actually
              // handed to fetch is the one that's aborted, this failure IS
              // that cancellation — whatever `fetch` threw, including a
              // custom, non-`AbortError`-named reason a caller passed to
              // `ac.abort(reason)`. Only fall back to sniffing `err`'s own
              // shape when our signal is not the cause, for a genuine
              // network failure.
              const signal = ctx.request.signal
              const kind = signal?.aborted === true
                ? (abortKind(signal.reason) ?? 'abort')
                : (abortKind(err) ?? 'network')
              const error = new ApiError({
                status: 0,
                kind,
                statusText: '',
                body: err,
                headers: new Headers(),
                request: { method: 'POST', url: ctx.request.url, params: variables },
              })
              return createNetworkErrorResult(error, execute)
            }
          }

          const headers = mergeHeaders(globalHeaders, operation.config.headers, options.headers)
          if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json')
          }

          const body = JSON.stringify({ query: operation.config.operation, variables })

          const context: MiddlewareContext = {
            request: {
              method: 'POST',
              url: endpoint,
              path: endpoint,
              params: variables,
              headers,
              body,
              signal: callerSignal,
            },
            requestName: name,
          }

          const composed = composeMiddleware(allMiddleware, core, options.skipMiddleware ?? [])
          // Same guard as create-api.ts's execute(), and for the same reason:
          // composeMiddleware has no guard of its own, so an async middleware
          // that throws would otherwise escape as a rejection. A middleware
          // that throws SYNCHRONOUSLY never gets as far as handing back a
          // promise for `.catch` to attach to — composed(context) itself
          // throws — so that case is caught here too, rather than falling
          // through to the outer catch below (which is for setup errors, not
          // middleware failures, and fallback-kinds them 'network').
          let resultPromise: Promise<Result<unknown>>
          try {
            resultPromise = composed(context).catch(
              (err: unknown) => buildFailedResult(err, context.request.signal, 'middleware')
            )
          } catch (err) {
            resultPromise = Promise.resolve(buildFailedResult(err, context.request.signal, 'middleware'))
          }
          return resultPromise.then(result => {
            // dedupeController is only assigned inside core() — if every
            // middleware short-circuited and core() never ran, it stays
            // undefined here. clear() with no controller deletes the map
            // entry unconditionally, which would be wrong in that case: it
            // could delete the entry belonging to a genuinely in-flight
            // request registered by someone else under the same name. So
            // only clear when this execute() actually registered.
            if (operation.config.dedupe && dedupeController) dedupeTracker.clear(name, dedupeController)
            if (result.error) fireOnError(result.error as ApiError)
            return result
          })
        } catch (err) {
          const error = new ApiError({
            status: 0,
            kind: 'network',
            statusText: '',
            body: err,
            headers: new Headers(),
            request: { method: 'POST', url: endpoint, params: variables },
          })
          fireOnError(error)
          return Promise.resolve(createNetworkErrorResult(error, execute))
        }
      }

      return execute()
    }
  }

  const allOperations: Record<string, Operation<any, any>> = {
    ...(config.operations ?? {}),
    ...(config.queries ?? {}),
    ...(config.mutations ?? {}),
  }

  const flatMethods: Record<string, Function> = {}
  for (const [name, operation] of Object.entries(allOperations)) {
    flatMethods[name] = buildMethod(name, operation)
  }

  if (config.operations) {
    return flatMethods
  }

  const result: Record<string, Record<string, Function>> = {}
  if (config.queries) {
    result.query = {}
    for (const name of Object.keys(config.queries)) {
      result.query[name] = flatMethods[name]
    }
  }
  if (config.mutations) {
    result.mutation = {}
    for (const name of Object.keys(config.mutations)) {
      result.mutation[name] = flatMethods[name]
    }
  }
  return result
}
