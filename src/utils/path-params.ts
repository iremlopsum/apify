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
 * Joins a base URL and a path with exactly one separating slash.
 *
 * A trailing slash on baseUrl is the shape `process.env.API_URL` usually has.
 * Naive concatenation produces '//', which some servers 404 on and which can
 * trigger a cross-origin redirect that drops the Authorization header. An
 * empty baseUrl (same-origin usage) passes the path through untouched.
 *
 * Exported so the error paths that report a URL without having built one —
 * a synchronous failure before buildUrl returns — can describe the same URL
 * the request would have used, rather than a naively concatenated one.
 *
 * @param baseUrl - The API base URL, with or without a trailing slash.
 * @param path - The path to append, with or without a leading slash.
 * @returns The joined URL.
 */
export function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path

  // Both sides may carry a query string — a baseUrl with a fixed API key, a
  // path template with a fixed filter — and a query must sit after the whole
  // path, not in the middle of it. Concatenating instead (as this did before
  // 4.2.1) put the path inside the base's query VALUE:
  // 'https://api.test/v1?key=abc' + '/items' became '.../v1?key=abc/items',
  // which resolves to path '/v1'. The request went to a different endpoint,
  // and nothing said so.
  const [basePath, baseQuery] = splitQuery(baseUrl)
  const [pathOnly, pathQuery] = splitQuery(path)

  const base = basePath.replace(/\/+$/, '')
  const tail = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`

  // Base params first, then the path template's; buildUrl's Phase 3 appends the
  // call's after both, so the wire order reads base -> template -> call.
  //
  // This ACCUMULATES rather than overriding, which is the one way it differs
  // from `mergeHeaders` — that uses `set()`, so a per-call header replaces a
  // global one. Here a call param with a key the base already used produces
  // BOTH: `?key=abc&key=xyz`, and which one a server honours is its own
  // business (`searchParams.get` takes the first; PHP takes the last).
  //
  // Accumulating is deliberate: array params already serialize as repeated
  // keys, so `tags=a&tags=b` is a shape this function must preserve, and
  // de-duplicating by key would silently collapse it. The consequence is that
  // a base-level param cannot be overridden per call — put it in middleware
  // instead if it needs to vary.
  const query = [baseQuery, pathQuery].filter(Boolean).join('&')

  return `${base}${tail}${query ? `?${query}` : ''}`
}

/**
 * Splits a URL fragment into its path part and its query part, without the `?`.
 *
 * Returns `['', '']`-shaped pairs rather than using `URL`, because both
 * arguments here are routinely relative (`baseUrl` may be `/api`, a `path`
 * always is) and `new URL` requires an absolute base it does not have.
 */
function splitQuery(value: string): [path: string, query: string] {
  const at = value.indexOf('?')
  return at === -1 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)]
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
  // -------------------------------------------------------------------------
  // Phase 0: Reject a fragment
  // -------------------------------------------------------------------------
  // A fragment is a client-side anchor — `fetch` never transmits it — so one
  // in a request URL cannot do anything the caller intended. Worse, before
  // 4.2.1 it silently ate the query string: '/docs#section' with { page: 2 }
  // produced '/docs#section?page=2', which the network layer reads as path
  // '/docs' with NO search at all. The param vanished and nothing reported it.
  //
  // Refused rather than stripped, because stripping hides the mistake and the
  // caller keeps a line of code that does nothing. Throwing here reaches the
  // caller as a Result, via execute()'s setup catch — the "never throws"
  // contract is unaffected.
  // -------------------------------------------------------------------------
  const fragmentIn = path.includes('#') ? { where: 'path', value: path } : baseUrl.includes('#') ? { where: 'baseUrl', value: baseUrl } : null
  if (fragmentIn) {
    const fragment = fragmentIn.value.slice(fragmentIn.value.indexOf('#'))
    throw new TypeError(
      `A URL fragment is never sent to the server, so it cannot appear in a ${fragmentIn.where}. ` +
      `Remove "${fragment}" from "${fragmentIn.value}".`
    )
  }

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
  //
  // The `g` flag matters: a template may legitimately repeat a token, as in
  // '/orgs/:id/members/:id'. Without it only the first occurrence would be
  // substituted and the second would survive into Phase 1b, which now throws
  // on any leftover token — turning a working path into a hard error.
  // -------------------------------------------------------------------------
  for (const [key, value] of Object.entries(params)) {
    const pattern = new RegExp(`:${key}(?=[^a-zA-Z0-9_]|$)`, 'g')

    // Replace first and compare, rather than test() then replace(): a global
    // regex carries lastIndex between calls, and doing it in one pass keeps
    // that state from mattering at all. The comparison is a reliable "did it
    // match" signal because encodeURIComponent always escapes ':' to '%3A',
    // so a substitution can never reproduce the token it replaced.
    const substituted = resolvedPath.replace(pattern, encodeURIComponent(String(value)))

    if (substituted !== resolvedPath) {
      // This param matched at least one path token — substitution encoded the
      // value so special characters (spaces, slashes) are safe in a segment.
      resolvedPath = substituted
    } else {
      // This param doesn't match any path token — keep it for later use
      // (either query string serialization or request body)
      remaining[key] = value
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1b: Reject any :token that no param filled in
  // -------------------------------------------------------------------------
  // A mismatch between the path template and the params type would otherwise
  // ship the literal token in the URL AND duplicate the value as a query
  // param — a silently wrong request that looks plausible in a network tab.
  //
  // The substitution loop above builds its pattern from the key directly and
  // accepts any key (including one starting with a digit, e.g. `:2fa`), so
  // detection must accept the same character set or a mismatched token could
  // still slip through undetected.
  //
  // A token must BEGIN a path segment. Splitting on '/' and anchoring the
  // match to the start of each segment expresses that without a lookbehind:
  // a colon appearing mid-segment (a time like `12:30`, a port embedded in a
  // path) is never mistaken for a token because it is not at index 0.
  //
  // Lookbehind is avoided deliberately. It is the only construct here that
  // some supported runtimes lack (Safari below 16.4), and an unsupported
  // regex *literal* is a parse-time SyntaxError: it would take down the whole
  // module rather than fail on the one call that used it. For a library whose
  // first promise is "runtime-agnostic", that trade is not worth one regex.
  // -------------------------------------------------------------------------
  const unresolved = resolvedPath
    .split('/')
    .map(segment => /^:[a-zA-Z0-9_]+/.exec(segment)?.[0])
    .filter((token): token is string => !!token)

  if (unresolved.length > 0) {
    throw new TypeError(
      `Unresolved path parameter${unresolved.length > 1 ? 's' : ''} ${unresolved.join(', ')} ` +
      `in path "${path}". Provide ${unresolved.length > 1 ? 'these keys' : 'this key'} in params, ` +
      `or correct the path template.`
    )
  }

  // -------------------------------------------------------------------------
  // Phase 2: Join base and path with exactly one separating slash
  // -------------------------------------------------------------------------
  let url = joinUrl(baseUrl, resolvedPath)

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

    // Only append a separator if there are actual query params -- and only a
    // '?' if the URL does not already have one. A `path` template may carry its
    // own query string ('/search/:q?x=1'), and appending a second '?' produced
    // a URL no server parses as intended.
    const query = searchParams.toString()
    if (query) url = `${url}${url.includes('?') ? '&' : '?'}${query}`

    // All remaining params have been consumed by the query string,
    // so return an empty object to signal "nothing left for the body"
    return { url, remaining: {} }
  }

  // When asQuery is false, remaining params are returned as-is for the caller
  // to handle (typically serialized as request body for POST/PUT/PATCH)
  return { url, remaining }
}
