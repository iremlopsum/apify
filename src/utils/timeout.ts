// =============================================================================
// timeout.ts — shared timeout-signal resolution
// =============================================================================
//
// Both createApi and createGraphQL resolve a whole-operation deadline the
// same way: a per-call timeout beats a per-request (or per-operation) one,
// and anything non-positive means "no timeout". This one function is the
// single source of truth for that precedence — see RequestConfig.timeout and
// CallOptions.timeout for the user-facing contract.
// =============================================================================

/**
 * Resolves the effective timeout into an `AbortSignal.timeout()` signal, or
 * `undefined` when no timeout applies.
 *
 * Precedence: per-call beats per-request/per-operation; non-positive (or
 * both omitted) means none.
 *
 * `AbortSignal.timeout()` accepts only an integer in `[0, 2^31 - 1]` and
 * throws a `RangeError` for anything else, so the value is normalised before
 * it gets there. Ordinary arithmetic produces out-of-contract values all the
 * time — `budget / 3`, `seconds * 1000 * 1.5`, `Number(process.env.TIMEOUT)` —
 * and without this the throw would surface as a `kind: 'network'` Result with
 * a `RangeError` body *and no request ever sent*, indistinguishable from being
 * offline. A fractional deadline is rounded down to the nearest millisecond; a
 * value beyond the 32-bit timer ceiling is clamped to it rather than wrapping
 * round to ~1 ms (the `TimeoutOverflowWarning` behaviour); `NaN` and anything
 * non-positive fall out through the `ms > 0` test as "no timeout".
 *
 * @param callTimeout - `CallOptions.timeout` for this specific call.
 * @param requestTimeout - `RequestConfig.timeout` / `OperationConfig.timeout`
 *   for the endpoint or operation.
 */
export function timeoutSignalFor(
  callTimeout: number | undefined,
  requestTimeout: number | undefined
): AbortSignal | undefined {
  // Math.min first so Infinity becomes the ceiling rather than surviving into
  // Math.floor; Math.floor(NaN) is NaN, which the `ms > 0` test rejects.
  const ms = Math.floor(Math.min(callTimeout ?? requestTimeout ?? 0, 2 ** 31 - 1))
  return ms > 0 ? AbortSignal.timeout(ms) : undefined
}
