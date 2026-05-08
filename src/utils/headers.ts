export function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const source of sources) {
    if (!source) continue
    if (source instanceof Headers) {
      source.forEach((value, key) => merged.set(key, value))
    } else {
      const entries: Iterable<[string, string]> = Array.isArray(source)
        ? source
        : Object.entries(source)
      for (const [key, value] of entries) {
        merged.set(key, value)
      }
    }
  }
  return merged
}
