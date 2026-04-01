/**
 * Represents the result of serializing a request body for use with the Fetch API.
 *
 * The `body` field contains the serialized payload ready to be passed directly to
 * `fetch()` as the `RequestInit.body` value. The `contentType` field contains the
 * appropriate MIME type string that should be set as the `Content-Type` header —
 * or `null` when the browser/runtime should determine the content type automatically
 * (e.g., for FormData where the boundary must be auto-generated).
 */
export interface SerializeResult {
  /** The serialized body payload, or `null` if no body should be sent. */
  body: BodyInit | null
  /** The Content-Type MIME string, or `null` if it should be omitted / auto-detected. */
  contentType: string | null
}

/**
 * Auto-detects the type of a request body and returns it in a format ready for
 * the Fetch API, along with the correct `Content-Type` header value.
 *
 * This utility exists because different body types require different serialization
 * strategies and content-type headers. Rather than forcing every call site to
 * handle this logic, we centralize it here so the rest of apify can simply call
 * `serializeBody(input)` and get back a ready-to-use `{ body, contentType }` pair.
 *
 * ### Serialization rules (checked in this order):
 *
 * | Input type        | Body output          | Content-Type                         |
 * |-------------------|----------------------|--------------------------------------|
 * | `null`/`undefined`| `null`               | `null`                               |
 * | `string`          | as-is                | `text/plain`                         |
 * | `FormData`        | as-is                | `null` (browser sets multipart boundary) |
 * | `URLSearchParams` | as-is                | `application/x-www-form-urlencoded`  |
 * | `Blob`            | as-is                | `application/octet-stream`           |
 * | `ArrayBuffer`     | as-is                | `application/octet-stream`           |
 * | Plain object      | `JSON.stringify()`   | `application/json`                   |
 *
 * @param input - The raw body value to serialize. Can be any type — the function
 *   will auto-detect and handle it appropriately.
 * @returns A {@link SerializeResult} with the serialized body and its content type.
 *
 * @example
 * ```ts
 * const { body, contentType } = serializeBody({ name: 'album', year: 2026 })
 * // body => '{"name":"album","year":2026}'
 * // contentType => 'application/json'
 * ```
 */
export function serializeBody(input: unknown): SerializeResult {
  // --- Null / undefined: no body to send ---
  // Early return for empty inputs. Both null and undefined mean "no body",
  // so we return null for both fields to signal that the request should
  // be sent without a body and without a Content-Type header.
  if (input === null || input === undefined) {
    return { body: null, contentType: null }
  }

  // --- String: pass through as plain text ---
  // Strings are already a valid BodyInit type, so no transformation is needed.
  // We set text/plain because that's the most accurate MIME type for raw strings.
  if (typeof input === 'string') {
    return { body: input, contentType: 'text/plain' }
  }

  // --- FormData: pass through, let the runtime handle Content-Type ---
  // FormData is special: the browser/runtime MUST set the Content-Type header
  // itself because it needs to generate a unique multipart boundary string.
  // If we set Content-Type manually, the boundary would be missing and the
  // server wouldn't be able to parse the multipart payload. That's why
  // contentType is null here — it signals the caller to NOT set the header.
  if (input instanceof FormData) {
    return { body: input, contentType: null }
  }

  // --- URLSearchParams: pass through with form-urlencoded type ---
  // URLSearchParams serializes to "key=value&key2=value2" format automatically
  // when used as a fetch body. We explicitly set the content type so the server
  // knows to parse it as form data rather than plain text.
  if (input instanceof URLSearchParams) {
    return { body: input, contentType: 'application/x-www-form-urlencoded' }
  }

  // --- Blob: pass through as binary ---
  // Blobs represent raw binary data (files, images, etc.). They're already a
  // valid BodyInit type. We use application/octet-stream as a generic binary
  // MIME type. If the caller knows the specific MIME type (e.g., image/png),
  // they can override the Content-Type header after serialization.
  if (input instanceof Blob) {
    return { body: input, contentType: 'application/octet-stream' }
  }

  // --- ArrayBuffer: pass through as binary ---
  // ArrayBuffers are raw binary data, similar to Blobs but without MIME metadata.
  // Same treatment as Blob — pass it through and mark it as octet-stream.
  if (input instanceof ArrayBuffer) {
    return { body: input, contentType: 'application/octet-stream' }
  }

  // --- Fallback: treat as a plain object and JSON-stringify it ---
  // If none of the above types matched, we assume the input is a plain object
  // (or array) that should be serialized as JSON. This is the most common case
  // for API requests — sending structured data as a JSON payload.
  // We use JSON.stringify which will throw if the value is not serializable
  // (e.g., circular references), which is the desired behavior — we want the
  // caller to know about serialization failures immediately.
  return { body: JSON.stringify(input), contentType: 'application/json' }
}
