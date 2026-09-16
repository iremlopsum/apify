import { anySignal } from './any-signal.js'
import { timeoutSignalFor } from './timeout.js'

/**
 * The two deadlines a call can carry, which are not the same thing.
 *
 * Under `share`, one request serves many callers, so "how long this operation
 * may take" and "how long *this caller* is willing to wait" diverge. Conflating
 * them is a real bug this library has shipped: a shared socket once ran 1077 ms
 * against a 100 ms configured deadline because a per-caller budget was applied
 * to the shared request.
 */
export interface Budget {
  /** Bounds the whole operation. Shared by every caller under `share`. */
  operation: AbortSignal | undefined
  /** Bounds this caller only. Never reaches a shared request. */
  perCaller: AbortSignal | undefined
}

/**
 * The operation's own deadline: how long the whole request may take.
 *
 * Under `share` this is the operation's limit alone — a single caller's
 * patience must never shorten a request that other callers are still waiting
 * on. Unshared there is one caller and one operation, so the caller's own
 * signal and per-call timeout are part of it.
 */
export function operationBudget(
  callTimeout: number | undefined,
  requestTimeout: number | undefined,
  callerSignal: AbortSignal | undefined,
  shared: boolean
): AbortSignal | undefined {
  if (shared) return timeoutSignalFor(undefined, requestTimeout)
  return anySignal([callerSignal, timeoutSignalFor(callTimeout, requestTimeout)])
}

/**
 * This caller's patience: their own signal and per-call timeout, and nothing
 * belonging to the operation.
 *
 * Only meaningful under `share`, where the two roles diverge. Unshared,
 * `operationBudget` already covers both.
 */
export function perCallerBudget(
  callTimeout: number | undefined,
  callerSignal: AbortSignal | undefined
): AbortSignal | undefined {
  return anySignal([callerSignal, timeoutSignalFor(callTimeout, undefined)])
}

/**
 * Resolve both deadlines for one call.
 *
 * Prefer `operationBudget` / `perCallerBudget` when only one field is
 * consumed. Building both is not free: the per-caller merge registers an
 * `abort` listener on the caller's signal, and `anySignal` only unregisters
 * when something actually aborts — so a discarded per-caller budget leaves a
 * listener on a signal that routinely outlives the request (a component-scoped
 * controller reused across many calls). One retained listener per call is the
 * accumulation `any-signal.ts` exists to avoid.
 *
 * When `shared` is false the distinction collapses — there is one caller and
 * one operation — so both fields are the same signal, and the caller's own
 * signal is merged in.
 *
 * @param callTimeout - `CallOptions.timeout`, this caller's patience.
 * @param requestTimeout - `RequestConfig.timeout`, the operation's own limit.
 * @param callerSignal - `CallOptions.signal`.
 * @param shared - Whether this call may join a shared request.
 */
export function resolveBudget(
  callTimeout: number | undefined,
  requestTimeout: number | undefined,
  callerSignal: AbortSignal | undefined,
  shared: boolean
): Budget {
  if (!shared) {
    // One signal serves both roles, and the shared identity is part of the
    // contract — callers compare the two fields to test for this case.
    const signal = operationBudget(callTimeout, requestTimeout, callerSignal, false)
    return { operation: signal, perCaller: signal }
  }

  return {
    operation: operationBudget(callTimeout, requestTimeout, callerSignal, true),
    perCaller: perCallerBudget(callTimeout, callerSignal),
  }
}
