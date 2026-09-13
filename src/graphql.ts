import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from './result.js'
import { composeMiddleware } from './middleware.js'
import { DedupeTracker } from './utils/dedupe.js'
import { mergeHeaders } from './utils/headers.js'
import { abortKind } from './utils/is-abort-error.js'
import { anySignal } from './utils/any-signal.js'
import type { CallOptions, Middleware, MiddlewareContext, Result, GraphQLBaseConfig, OperationConfig, GraphQLError } from './types.js'

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

  function buildMethod(name: string, operation: Operation<any, any>) {
    return (variables: object = {}, options: CallOptions = {}): Promise<Result<unknown>> => {
      const execute = (): Promise<Result<unknown>> => {
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
          const timeoutMs = options.timeout ?? operation.config.timeout ?? 0
          const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
          const callerSignal: AbortSignal | undefined = anySignal([options.signal, timeoutSignal])
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
                let body: unknown
                try {
                  const text = await response.text()
                  body = text ? JSON.parse(text) : null
                } catch {
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

              const text = await response.text()
              const gqlBody = text
                ? (JSON.parse(text) as { data?: unknown; errors?: GraphQLError[] })
                : null

              if (gqlBody?.errors?.length) {
                const error = new ApiError({
                  status: 200,
                  kind: 'http',
                  statusText: 'GraphQL Error',
                  body: gqlBody.errors,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              return createSuccessResult(gqlBody?.data ?? null, response, execute)
            } catch (err) {
              const error = new ApiError({
                status: 0,
                kind: abortKind(err) ?? 'network',
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
          return composed(context).then(result => {
            // dedupeController is only assigned inside core() — if every
            // middleware short-circuited and core() never ran, it stays
            // undefined here. clear() with no controller deletes the map
            // entry unconditionally, which would be wrong in that case: it
            // could delete the entry belonging to a genuinely in-flight
            // request registered by someone else under the same name. So
            // only clear when this execute() actually registered.
            if (operation.config.dedupe && dedupeController) dedupeTracker.clear(name, dedupeController)
            if (result.error && onError) onError(result.error as ApiError)
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
          if (onError) onError(error)
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
