import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from './result.js'
import { composeMiddleware } from './middleware.js'
import { DedupeTracker } from './utils/dedupe.js'
import { mergeHeaders } from './utils/headers.js'
import type { CallOptions, Middleware, MiddlewareContext, Result, GraphQLBaseConfig, OperationConfig } from './types.js'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof TOperations]: TOperations[K] extends Operation<infer V, infer D>
    ? GraphQLMethod<V, D>
    : never
}

type SplitClient<TQ, TM> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TQ extends Record<string, Operation<any, any>> ? { query: FlatClient<TQ> } : object) &
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TM extends Record<string, Operation<any, any>> ? { mutation: FlatClient<TM> } : object)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithOperations<T> = GraphQLBaseConfig & {
  operations: T
  queries?: never
  mutations?: never
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithSplit<TQ, TM> = GraphQLBaseConfig & {
  operations?: never
  queries?: TQ
  mutations?: TM
}

// ---------------------------------------------------------------------------
// createGraphQL — overloaded factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGraphQL<T extends Record<string, Operation<any, any>>>(
  config: WithOperations<T>
): FlatClient<T>
export function createGraphQL<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TQ extends Record<string, Operation<any, any>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TM extends Record<string, Operation<any, any>>
>(config: WithSplit<TQ, TM>): SplitClient<TQ, TM>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGraphQL(config: any): any {
  const {
    endpoint,
    middleware: globalMiddleware = [],
    headers: globalHeaders,
    onError,
  } = config

  const dedupeTracker = new DedupeTracker()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildMethod(name: string, operation: Operation<any, any>) {
    return (variables: object = {}, options: CallOptions = {}): Promise<Result<unknown>> => {
      const execute = (): Promise<Result<unknown>> => {
        try {
          const allMiddleware: Middleware[] = [
            ...globalMiddleware,
            ...(operation.config.middleware ?? []),
            ...(options.middleware ?? []),
          ]

          let effectiveSignal: AbortSignal | undefined = options.signal
          if (operation.config.dedupe) {
            effectiveSignal = dedupeTracker.track(name, options.signal)
          }

          const core = async (ctx: MiddlewareContext): Promise<Result<unknown>> => {
            try {
              const response = await fetch(ctx.request.url, {
                method: 'POST',
                headers: ctx.request.headers,
                body: ctx.request.body as string,
                signal: effectiveSignal,
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
                  statusText: response.statusText,
                  body,
                  headers: response.headers,
                  request: { method: 'POST', url: ctx.request.url, params: variables },
                })
                return createErrorResult(error, response, execute)
              }

              const text = await response.text()
              const gqlBody = text
                ? (JSON.parse(text) as { data?: unknown; errors?: unknown[] })
                : null

              if (gqlBody?.errors?.length) {
                const error = new ApiError({
                  status: 200,
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
            },
            requestName: name,
          }

          const composed = composeMiddleware(allMiddleware, core, options.skipMiddleware ?? [])
          return composed(context).then(result => {
            if (operation.config.dedupe) dedupeTracker.clear(name)
            if (result.error && onError) onError(result.error as ApiError)
            return result
          })
        } catch (err) {
          const error = new ApiError({
            status: 0,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allOperations: Record<string, Operation<any, any>> = {
    ...(config.operations ?? {}),
    ...(config.queries ?? {}),
    ...(config.mutations ?? {}),
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const flatMethods: Record<string, Function> = {}
  for (const [name, operation] of Object.entries(allOperations)) {
    flatMethods[name] = buildMethod(name, operation)
  }

  if (config.operations) {
    return flatMethods
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
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
