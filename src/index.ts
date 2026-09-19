// =============================================================================
// index.ts — Public API surface for the apify library
// =============================================================================
// This barrel file re-exports everything consumers need. Internal modules
// (middleware composition engine, utils) are NOT exported — they are
// implementation details.
// =============================================================================

// ---------------------------------------------------------------------------
// Core — the two things you need to build an API client
// ---------------------------------------------------------------------------

/** Factory that wires Request definitions into a typed, callable API object. */
export { createApi } from './create-api.js'

/** Typed request definition — one instance per API endpoint. */
export { Request } from './request.js'

/** Typed factory — infers path params from the `path` literal. */
export { defineRequest } from './define-request.js'

/** Walks a paginated endpoint, yielding one Result per page. */
export { paginate } from './paginate.js'

/** Options for `paginate` — `next`, `maxPages`, and any CallOptions. */
export type { PaginateOptions } from './paginate.js'

// ---------------------------------------------------------------------------
// Error class — exported as a value so consumers can use `instanceof`
// ---------------------------------------------------------------------------

/** Structured error with status, body, headers, and request context. */
export { ApiError } from './result.js'

// ---------------------------------------------------------------------------
// Types — everything consumers might need for type annotations
// ---------------------------------------------------------------------------

export type {
  RequestConfig,
  ApiConfig,
  CallOptions,
  Result,
  SuccessResult,
  ErrorResult,
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  ApiErrorKind,
  StandardSchemaV1,
  InferOutput,
  StandardIssue
} from './types.js'

// ---------------------------------------------------------------------------
// GraphQL — typed GraphQL client, exported from the core entry point
// ---------------------------------------------------------------------------

/** Factory and primitives for building a typed GraphQL client. */
export { createGraphQL, Operation, gql } from './graphql.js'
export type { GraphQLError, OperationConfig, GraphQLBaseConfig } from './types.js'
