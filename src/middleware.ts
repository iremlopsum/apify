// =============================================================================
// middleware.ts — Middleware composition engine for the apify library
// =============================================================================
//
// This module implements the "onion model" middleware pattern, similar to how
// Koa, Express, or Redux middleware work. The key idea is that middleware
// functions wrap each other like layers of an onion:
//
//   Request → [MW1 → [MW2 → [MW3 → [Core]]]]
//
// Each middleware receives a `context` (the request being made) and a `next`
// function (which invokes the next layer). A middleware can:
//
//   1. Modify the context before calling next() (e.g., inject auth headers)
//   2. Inspect/transform the result after next() returns (e.g., logging)
//   3. Short-circuit by returning early without calling next() (e.g., cache hit)
//   4. Call next() multiple times for retry behavior (e.g., retry on 401)
//
// The composition function also supports a `skip` array — middleware references
// that should be filtered out before composing. This enables per-call overrides
// where certain global middleware can be bypassed.
// =============================================================================

import type { Middleware, MiddlewareContext, Result } from './types.js'

// -----------------------------------------------------------------------------
// Core Function Type
// -----------------------------------------------------------------------------

/**
 * Signature for the "core" function — the innermost layer of the onion.
 *
 * This is the function that actually performs the HTTP fetch. It receives
 * the fully-prepared {@link MiddlewareContext} (with all middleware
 * modifications applied) and returns a {@link Result}.
 *
 * The core function is NOT a middleware — it does not receive a `next`
 * parameter because there is nothing after it. It is the terminal point
 * of the middleware chain.
 *
 * @param context - The middleware context containing the prepared request.
 * @returns A promise resolving to the Result of the HTTP call.
 */
export type CoreFn = (context: MiddlewareContext) => Promise<Result<unknown>>

// -----------------------------------------------------------------------------
// composeMiddleware
// -----------------------------------------------------------------------------

/**
 * Composes an array of middleware into a single executable function using
 * the onion model.
 *
 * **How it works:**
 *
 * Given middleware `[A, B, C]` and a core function, calling the composed
 * function produces this execution order:
 *
 * ```
 * A "before" logic
 *   B "before" logic
 *     C "before" logic
 *       core(context) ← actual fetch happens here
 *     C "after" logic
 *   B "after" logic
 * A "after" logic
 * ```
 *
 * **Skip filtering:**
 *
 * The `skip` parameter accepts an array of middleware references. Before
 * composing, any middleware whose reference (===) matches an entry in `skip`
 * is removed from the chain. This enables per-call overrides like:
 *
 * ```ts
 * api.getUser({ id: '1' }, { skipMiddleware: [cacheMiddleware] })
 * ```
 *
 * **No double-call guard:**
 *
 * Unlike some middleware engines (e.g., Koa), this implementation does NOT
 * prevent a middleware from calling `next()` more than once. This is
 * intentional — retry middleware needs to call `next()` sequentially in a
 * loop to re-execute the downstream chain. Each `next()` call creates a
 * fresh traversal from the current position onward.
 *
 * @param middleware - Array of middleware functions to compose. Order matters:
 *   the first middleware in the array is the outermost layer (runs first on
 *   the way "in" and last on the way "out").
 * @param core - The innermost function that performs the actual HTTP fetch.
 *   This is called when the last middleware in the chain calls `next()`.
 * @param skip - Optional array of middleware references to exclude from the
 *   chain. Comparison is by reference identity (===), not by value.
 * @returns A function that takes a {@link MiddlewareContext} and returns a
 *   `Promise<Result<unknown>>`. This is the fully composed pipeline ready
 *   to be executed.
 *
 * @example
 * ```ts
 * // Compose global + per-request middleware with a fetch core
 * const pipeline = composeMiddleware(
 *   [authMiddleware, logMiddleware, cacheMiddleware],
 *   fetchCore,
 *   [cacheMiddleware], // skip cache for this call
 * )
 *
 * const result = await pipeline(context)
 * ```
 */
export function composeMiddleware(
  middleware: Middleware[],
  core: CoreFn,
  skip: Middleware[] = []
): (context: MiddlewareContext) => Promise<Result<unknown>> {
  // -------------------------------------------------------------------------
  // Step 1: Filter out any middleware that appears in the skip list.
  //
  // We use Array.prototype.includes which compares by reference (===).
  // This means the caller must pass the exact same function reference that
  // was registered — factory-created middleware (e.g., `retryMiddleware(3)`)
  // must be stored in a variable to be skippable.
  // -------------------------------------------------------------------------
  const active = middleware.filter(mw => !skip.includes(mw))

  // -------------------------------------------------------------------------
  // Step 2: Return the composed function.
  //
  // The returned function closes over `active` and `core`, creating a
  // dispatch chain via recursive calls. Each call to `dispatch(i)` either:
  //   - Invokes the i-th middleware (passing dispatch(i+1) as `next`), or
  //   - Invokes the core function if i has reached the end of the array.
  // -------------------------------------------------------------------------
  return (context: MiddlewareContext): Promise<Result<unknown>> => {
    /**
     * Recursive dispatch function that walks through the middleware array.
     *
     * When called with index `i`:
     * - If `i >= active.length`, we've passed all middleware → call core.
     * - Otherwise, call `active[i]` and pass a `next` function that
     *   dispatches to `i + 1`.
     *
     * **Why no double-call guard?**
     * Retry middleware calls `next()` multiple times in a sequential loop.
     * Each call re-dispatches from position `i + 1` onward, effectively
     * re-running all downstream middleware and the core function. This is
     * safe because each call is awaited before the next one starts — there
     * are no concurrent race conditions.
     *
     * @param i - The current index in the `active` middleware array.
     * @returns The Result from the middleware/core chain.
     */
    const dispatch = (i: number): Promise<Result<unknown>> => {
      // Base case: all middleware have been traversed, call the core function.
      // The core function receives the (possibly mutated) context and performs
      // the actual HTTP fetch.
      if (i >= active.length) return core(context)

      // Recursive case: invoke the current middleware, passing a `next`
      // function that advances to the next index in the chain.
      const mw = active[i]
      return mw(context, () => dispatch(i + 1))
    }

    // Kick off the chain starting from the first middleware (index 0).
    return dispatch(0)
  }
}
