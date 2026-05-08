export function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const source of sources) {
    if (!source) continue
    const entries: Iterable<[string, string]> =
      source instanceof Headers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (source as any).entries()
        : Array.isArray(source)
          ? source
          : Object.entries(source)
    for (const [key, value] of entries) {
      merged.set(key, value)
    }
  }
  return merged
}
