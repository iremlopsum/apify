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
 * @param callTimeout - `CallOptions.timeout` for this specific call.
 * @param requestTimeout - `RequestConfig.timeout` / `OperationConfig.timeout`
 *   for the endpoint or operation.
 */
export function timeoutSignalFor(
  callTimeout: number | undefined,
  requestTimeout: number | undefined
): AbortSignal | undefined {
  const ms = callTimeout ?? requestTimeout ?? 0
  return ms > 0 ? AbortSignal.timeout(ms) : undefined
}
