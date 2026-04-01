// =============================================================================
// path-params.ts — Path parameter substitution and query string building
// =============================================================================
//
// This utility handles the URL construction pipeline:
//
// 1. Start with a base URL and a path template (e.g., '/api' + '/items/:id')
// 2. Scan the params object for keys that match `:param` tokens in the path
// 3. Replace matched tokens with URI-encoded values
// 4. Separate consumed (path) params from remaining params
// 5. Optionally serialize remaining params as a query string
//
// The separation between "path params" and "remaining params" is important
// because it determines what goes in the URL vs. what goes in the request body
// (for POST/PUT/PATCH) or query string (for GET/DELETE).
// =============================================================================

/**
 * Result of building a URL from a base, path template, and params.
 *
 * @property url - The fully constructed URL (base + resolved path + optional query string)
 * @property remaining - Params that were NOT consumed by path param substitution.
 *   When `asQuery` is true, this is always empty (all remaining params went into
 *   the query string). When `asQuery` is false, these params are available for
 *   the caller to serialize as a request body.
 */
interface BuildUrlResult {
  url: string
  remaining: Record<string, unknown>
}

/**
 * Substitutes `:param` tokens in the path with matching values from params,
 * optionally appends remaining params as a query string.
 *
 * This is the main URL construction function used by the request engine.
 * It handles the full lifecycle from path template to final URL.
 *
 * **Path param matching** uses regex with a word-boundary lookahead to prevent
 * partial matches. For example, a param key `id` will match `:id` but NOT
 * `:idExtra`. This is achieved by requiring that the character after the param
 * name is either a non-alphanumeric-underscore character or end of string.
 *
 * **Query string rules** (when `asQuery` is true):
 * - Primitives: `{ page: 1 }` → `?page=1`
 * - Arrays: repeated keys — `{ tags: ['a', 'b'] }` → `?tags=a&tags=b`
 * - null/undefined: silently omitted
 * - Nested objects: throws TypeError (must flatten before passing)
 *
 * @param baseUrl - API base URL (e.g., '/api' or 'https://api.example.com')
 * @param path - Path template with optional `:param` tokens (e.g., '/items/:id')
 * @param params - Key-value params to substitute and/or serialize
 * @param asQuery - If true, remaining (non-path) params are appended as query string.
 *   Defaults to false.
 * @returns The built URL and any remaining params not consumed by path or query
 *
 * @example
 * ```ts
 * // Path param substitution
 * buildUrl('/api', '/items/:id', { id: '42', page: 1 })
 * // → { url: '/api/items/42', remaining: { page: 1 } }
 *
 * // With query string
 * buildUrl('/api', '/items', { page: 1, limit: 20 }, true)
 * // → { url: '/api/items?page=1&limit=20', remaining: {} }
 * ```
 */
export function buildUrl(baseUrl: string, path: string, params: Record<string, unknown>, asQuery = false): BuildUrlResult {
  let resolvedPath = path
  const remaining: Record<string, unknown> = {}

  // -------------------------------------------------------------------------
  // Phase 1: Path parameter substitution
  // -------------------------------------------------------------------------
  // Iterate over every param key and check if the path contains a matching
  // `:key` token. We use a regex with a lookahead to ensure we only match
  // complete param names — `:id` must NOT match inside `:idExtra`.
  //
  // The regex pattern `:key(?=[^a-zA-Z0-9_]|$)` means:
  // - Match the literal `:key`
  // - Followed by either a non-word character (/, ?, etc.) or end of string
  // - This prevents `:id` from matching `:idExtra` because 'E' is alphanumeric
  // -------------------------------------------------------------------------
  for (const [key, value] of Object.entries(params)) {
    const pattern = new RegExp(`:${key}(?=[^a-zA-Z0-9_]|$)`)

    if (pattern.test(resolvedPath)) {
      // This param matches a path token — substitute it in the URL.
      // encodeURIComponent ensures special characters (spaces, slashes, etc.)
      // are properly encoded for use in URL path segments.
      resolvedPath = resolvedPath.replace(pattern, encodeURIComponent(String(value)))
    } else {
      // This param doesn't match any path token — keep it for later use
      // (either query string serialization or request body)
      remaining[key] = value
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Construct the base URL
  // -------------------------------------------------------------------------
  let url = `${baseUrl}${resolvedPath}`

  // -------------------------------------------------------------------------
  // Phase 3: Optional query string serialization
  // -------------------------------------------------------------------------
  // When asQuery is true (typically for GET/DELETE requests), all remaining
  // params are serialized into a URL query string. After serialization,
  // `remaining` is cleared to empty because all params have been consumed.
  // -------------------------------------------------------------------------
  if (asQuery) {
    const searchParams = new URLSearchParams()

    for (const [key, value] of Object.entries(remaining)) {
      // Skip null and undefined — these are intentionally omitted from the
      // query string (the server should treat absent keys as "not provided")
      if (value === null || value === undefined) continue

      if (Array.isArray(value)) {
        // Arrays use repeated keys: tags=a&tags=b
        // This is the most widely supported format across web servers and
        // frameworks (Express, Rails, Django, etc.)
        for (const item of value) {
          searchParams.append(key, String(item))
        }
      } else if (typeof value === 'object') {
        // Nested objects can't be meaningfully serialized as query strings
        // without choosing a convention (brackets, dots, JSON). Rather than
        // picking one and surprising users, we throw a clear error telling
        // them to flatten the data structure first.
        throw new TypeError(`Nested objects are not supported in query strings. Flatten param "${key}" before passing.`)
      } else {
        // Primitive values (string, number, boolean) — convert to string
        searchParams.append(key, String(value))
      }
    }

    // Only append the '?' if there are actual query params
    const query = searchParams.toString()
    if (query) url = `${url}?${query}`

    // All remaining params have been consumed by the query string,
    // so return an empty object to signal "nothing left for the body"
    return { url, remaining: {} }
  }

  // When asQuery is false, remaining params are returned as-is for the caller
  // to handle (typically serialized as request body for POST/PUT/PATCH)
  return { url, remaining }
}
