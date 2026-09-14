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
 * offline. A fractional deadline is rounded down to the nearest millisecond,
 * but never down to zero: any resolved value greater than zero is clamped up
 * to a 1 ms minimum, so `timeout: 0.5` still produces a real (if generous)
 * deadline instead of silently meaning "no timeout" — the opposite of the
 * caller's intent. A value beyond the 32-bit timer ceiling is clamped to it
 * rather than wrapping round to ~1 ms (the `TimeoutOverflowWarning`
 * behaviour); `NaN` and anything non-positive (including omitted) fall out
 * through the `raw > 0` test as "no timeout", same as before.
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
  // a later Math.floor. The `raw > 0` test happens BEFORE flooring: flooring
  // first would turn any 0 < raw < 1 deadline into 0, which then fails this
  // very test and disables the timeout entirely — the bug this guards
  // against. NaN also falls out here, since `NaN > 0` is false.
  const raw = Math.min(callTimeout ?? requestTimeout ?? 0, 2 ** 31 - 1)
  if (!(raw > 0)) return undefined
  // A genuine positive deadline always yields at least 1ms, even when it
  // floors to 0 (e.g. `timeout: 0.5`) — flooring to nothing would silently
  // mean "no timeout", the opposite of what a positive value asked for.
  const ms = Math.max(1, Math.floor(raw))
  return AbortSignal.timeout(ms)
}
