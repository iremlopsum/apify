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
 * Resolve both deadlines for one call.
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
    const signal = anySignal([callerSignal, timeoutSignalFor(callTimeout, requestTimeout)])
    return { operation: signal, perCaller: signal }
  }

  return {
    // The operation's own limit only. A caller's patience must never shorten
    // a request other callers are still waiting on.
    operation: timeoutSignalFor(undefined, requestTimeout),
    // This caller's patience and their own signal. Observed per-caller.
    perCaller: anySignal([callerSignal, timeoutSignalFor(callTimeout, undefined)]),
  }
}
