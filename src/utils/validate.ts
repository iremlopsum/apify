// =============================================================================
// validate.ts — the Standard Schema protocol, in one place
// =============================================================================
//
// Both pipelines validate, and both need the same three things: call
// `~standard.validate`, await it when the validator is async, and tell a value
// apart from a set of issues. That is a protocol adapter, so it lives in one
// util — the same way `buildUrl` and `mergeHeaders` are shared.
//
// What does NOT live here is the `ApiError`. Each pipeline builds its own, from
// its own request metadata. "Parallel implementations, not layers" is a rule
// about the pipelines; it is not a ban on shared utilities.
// =============================================================================

import type { StandardSchemaV1, StandardIssue } from '../types.js'

/** A value the schema accepted, or the reasons it refused. */
export type SchemaOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly StandardIssue[] }

/**
 * Runs a Standard Schema validator against a value.
 *
 * Always async, because `validate` may return a promise and a caller that had
 * to branch on that would get it wrong once. Both call sites are already in an
 * async path, so the extra microtask costs nothing.
 *
 * This function does not catch. A validator that *throws* rather than returning
 * issues is a bug in the consumer's schema, and each call site wraps it to
 * report that as a `'parse'` error with the right request metadata — a throw
 * escaping to the seam's enclosing catch would be classified as a network
 * failure instead. See the spec's D7.
 */
export async function runSchema(schema: StandardSchemaV1<unknown>, value: unknown): Promise<SchemaOutcome> {
  const result = await schema['~standard'].validate(value)
  return result.issues === undefined
    ? { ok: true, value: result.value }
    : { ok: false, issues: result.issues }
}
