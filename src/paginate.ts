// =============================================================================
// paginate.ts — walk a paginated endpoint, one page at a time
// =============================================================================
//
// Standalone rather than a method on every generated endpoint. Attaching
// `api.listItems.pages(...)` would mean a property on every method in the `Api`
// mapped type and a closure per endpoint, allocated whether or not anyone
// paginates. This costs nothing unless imported.
//
// The endpoint arrives as a plain function, which is all a `createApi` method
// is, so params and response infer structurally and nothing needs exporting
// from create-api.ts.
// =============================================================================

import type { CallOptions, Result, SuccessResult } from './types.js'

/**
 * How to continue, and when to stop.
 *
 * @typeParam TParams - The endpoint's params type.
 * @typeParam TResponse - The endpoint's success data type.
 */
export interface PaginateOptions<TParams extends object, TResponse> extends CallOptions {
  /**
   * Builds the params for the next page, or returns nullish to stop.
   *
   * Returns **params**, not a cursor. A cursor would leave this function
   * deciding where to put it — `cursor`? `page_token`? `after`? — which is a
   * convention, and a config option per API in existence is what `buildUrl`'s
   * refusal to guess a nested-query-string format already rejected.
   *
   * The previous params arrive as the second argument so the common case is a
   * spread:
   *
   * ```ts
   * next: (page, prev) => page.data.cursor
   *   ? { ...prev, cursor: page.data.cursor }
   *   : undefined
   * ```
   *
   * Only ever called with a page that succeeded — an error page has no data to
   * read a cursor from, and ends the walk.
   *
   * It is the caller's own function, invoked inside their own `for await`, so a
   * throw here propagates to them with their own stack rather than becoming a
   * `Result`. That is not a hole in "never throws": that rule is about request
   * failures, and this is a bug in the caller's callback. Converting it would
   * need an error kind that fits nothing, and would hide the stack that
   * identifies it.
   */
  next: (page: SuccessResult<TResponse>, params: TParams) => TParams | undefined | null
}

/**
 * Walks a paginated endpoint, yielding one `Result` per page.
 *
 * @example
 * ```ts
 * for await (const page of paginate(api.listItems, { limit: 50 }, {
 *   next: (p, prev) => p.data.cursor ? { ...prev, cursor: p.data.cursor } : undefined,
 * })) {
 *   if (page.error) break
 *   render(page.data.items)
 * }
 * ```
 *
 * Yields `Result`s rather than unwrapping them, because that is the shape every
 * other entry point returns — a paging loop should not invent a second
 * convention for failure.
 *
 * @param endpoint - Any `createApi` method, or any function of that shape.
 * @param params - The params for the first page.
 * @param options - `next`, plus any `CallOptions` to apply to every request.
 */
export async function* paginate<TParams extends object, TResponse>(
  endpoint: (params: TParams, options?: CallOptions) => Promise<Result<TResponse>>,
  params: TParams,
  options: PaginateOptions<TParams, TResponse>
): AsyncGenerator<Result<TResponse>, void, undefined> {
  const { next, ...callOptions } = options
  let current: TParams | undefined | null = params

  while (current !== undefined && current !== null) {
    const page: Result<TResponse> = await endpoint(current, callOptions)
    yield page

    // An error page ends the walk. Not a policy choice — `next` is typed to
    // receive a SuccessResult, and a failed page carries no data from which to
    // build the following params.
    if (page.error !== null) return

    current = next(page, current)
  }
}
