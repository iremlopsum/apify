import { describe, it, expect, vi, afterEach } from 'vitest'
import { runSchema } from '../src/utils/validate.js'
import type { StandardSchemaV1 } from '../src/types.js'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'

/** A Standard Schema validator built from a plain predicate — no dependency needed to test one. */
const schemaOf = <T>(fn: (v: unknown) => { value: T } | { issues: { message: string }[] }, async = false): StandardSchemaV1<T> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) => (async ? Promise.resolve(fn(v)) : fn(v)) as never,
  },
})

const evenNumber = (async = false) =>
  schemaOf<number>(v => (typeof v === 'number' && v % 2 === 0 ? { value: v } : { issues: [{ message: 'not an even number' }] }), async)

describe('runSchema', () => {
  it('returns the validated value on success', async () => {
    const r = await runSchema(evenNumber(), 4)
    expect(r).toEqual({ ok: true, value: 4 })
  })

  it('returns the issues on failure', async () => {
    const r = await runSchema(evenNumber(), 3)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues).toEqual([{ message: 'not an even number' }])
  })

  it('awaits a validator that returns a promise', async () => {
    const r = await runSchema(evenNumber(true), 4)
    expect(r).toEqual({ ok: true, value: 4 })
  })

  it('returns the transformed value, not the input', async () => {
    // The whole reason `data` is the schema's output: a transforming schema
    // changes what the caller receives.
    const doubled = schemaOf<number>(v => ({ value: (v as number) * 2 }))
    const r = await runSchema(doubled, 21)
    expect(r).toEqual({ ok: true, value: 42 })
  })
})

const jsonOf = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('REST — schema validation', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const apiWith = (schema?: StandardSchemaV1<unknown>) => createApi({
    baseUrl: 'https://api.test',
    requests: { get: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', schema }) },
  })

  it('returns data when the schema accepts', async () => {
    vi.stubGlobal('fetch', jsonOf(4))
    const r = await apiWith(evenNumber()).get()
    expect(r.error).toBeNull()
    expect(r.data).toBe(4)
  })

  it('reports a parse error with the issues in body when the schema refuses', async () => {
    vi.stubGlobal('fetch', jsonOf(3))
    const r = await apiWith(evenNumber()).get()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.body).toEqual([{ message: 'not an even number' }])
    // The server answered fine — the response's own status is kept, as with
    // every other 'parse' error.
    expect(r.error?.status).toBe(200)
  })

  it('awaits an async validator', async () => {
    vi.stubGlobal('fetch', jsonOf(4))
    const r = await apiWith(evenNumber(true)).get()
    expect(r.data).toBe(4)
  })

  it('gives data the schema OUTPUT, not the wire value', async () => {
    vi.stubGlobal('fetch', jsonOf(21))
    const doubled = schemaOf<number>(v => ({ value: (v as number) * 2 }))
    const r = await apiWith(doubled).get()
    expect(r.data).toBe(42)
  })

  it('reports a THROWING validator as parse, not as a network failure', async () => {
    // The seam sits inside the outer catch, which reports status 0 and kind
    // 'network' (or 'abort' if a signal happens to be aborted). Without its own
    // try/catch, a bug in the consumer's schema would point telemetry at the
    // network on a request that completed fine.
    vi.stubGlobal('fetch', jsonOf(4))
    const boom = schemaOf<number>(() => { throw new Error('validator exploded') })
    const r = await apiWith(boom).get()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.status).toBe(200)
    expect(String((r.error?.body as Error)?.message)).toContain('validator exploded')
  })

  it('changes nothing when no schema is given', async () => {
    vi.stubGlobal('fetch', jsonOf({ anything: true }))
    const r = await apiWith().get()
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ anything: true })
  })

  it('does not validate a non-2xx body — reports kind: http with the body untouched', async () => {
    // A non-2xx body is diagnostic and often a different shape; the schema
    // never sees it, and it must not be misreported as a validation failure.
    vi.stubGlobal('fetch', jsonOf({ message: 'boom' }, 500))
    const r = await apiWith(evenNumber()).get()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.body).toEqual({ message: 'boom' })
  })

  it('responseType: none plus a schema reaches validation with undefined and reports parse', async () => {
    vi.stubGlobal('fetch', jsonOf({ anything: true }))
    const api = createApi({
      baseUrl: 'https://api.test',
      requests: {
        get: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/x', responseType: 'none', schema: evenNumber() }),
      },
    })
    const r = await api.get()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.body).toEqual([{ message: 'not an even number' }])
  })
})

import { createGraphQL, Operation, gql } from '../src/graphql.js'

describe('GraphQL — schema validation', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const gqlWith = (schema?: StandardSchemaV1<unknown>) => createGraphQL({
    endpoint: 'https://api.test/graphql',
    operations: { thing: new Operation<Record<string, never>, unknown>({ operation: gql`query { thing }`, schema }) },
  })

  const gqlData = (data: unknown) =>
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }))

  it('returns data when the schema accepts', async () => {
    vi.stubGlobal('fetch', gqlData(4))
    const r = await gqlWith(evenNumber()).thing()
    expect(r.error).toBeNull()
    expect(r.data).toBe(4)
  })

  it('reports a parse error with the issues in body when the schema refuses', async () => {
    vi.stubGlobal('fetch', gqlData(3))
    const r = await gqlWith(evenNumber()).thing()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.body).toEqual([{ message: 'not an even number' }])
    expect(r.error?.status).toBe(200)
  })

  it('awaits an async validator', async () => {
    vi.stubGlobal('fetch', gqlData(4))
    const r = await gqlWith(evenNumber(true)).thing()
    expect(r.data).toBe(4)
  })

  it('gives data the schema OUTPUT, not the wire value', async () => {
    vi.stubGlobal('fetch', gqlData(21))
    const doubled = schemaOf<number>(v => ({ value: (v as number) * 2 }))
    const r = await gqlWith(doubled).thing()
    expect(r.data).toBe(42)
  })

  it('reports a THROWING validator as parse, not as a network failure', async () => {
    vi.stubGlobal('fetch', gqlData(4))
    const boom = schemaOf<number>(() => { throw new Error('validator exploded') })
    const r = await gqlWith(boom).thing()
    expect(r.error?.kind).toBe('parse')
    expect(r.error?.status).toBe(200)
    expect(String((r.error?.body as Error)?.message)).toContain('validator exploded')
  })

  it('changes nothing when no schema is given', async () => {
    vi.stubGlobal('fetch', gqlData({ anything: true }))
    const r = await gqlWith().thing()
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ anything: true })
  })

  it('does not validate a non-2xx body — reports kind: http with the body untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })))
    const r = await gqlWith(evenNumber()).thing()
    expect(r.error?.kind).toBe('http')
    expect(r.error?.body).toEqual({ message: 'boom' })
  })
})
