import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi } from '../src/create-api.js'
import { Request } from '../src/request.js'
import { createGraphQL, Operation } from '../src/graphql.js'

// ---------------------------------------------------------------------------
// onError is the oldest and most-used of the library's user callbacks, and the
// only one the 2.2.0 retry policy did not guard (retryOn, onRetry and a custom
// delay curve all are). It runs *after* the Result is in hand, so anything it
// throws rejects a promise that already holds a perfectly good Result: the
// caller sees a throw for a request that merely came back 500. A Sentry client
// in a misconfigured environment, or a logger reaching for
// `error.response.status` on a network error where `response` is null, is all
// it takes — and the never-throws contract is the whole point of the library.
// ---------------------------------------------------------------------------

const explode = (): never => { throw new Error('the error reporter itself is broken') }

describe('onError is guarded — createApi', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not reject the caller when onError throws on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const api = createApi({
      baseUrl: '',
      onError: explode,
      requests: { boom: new Request<Record<string, never>, unknown>({ method: 'GET', path: '/boom' }) },
    })

    const r = await api.boom()

    expect(r.error).not.toBeNull()
    expect(r.error!.status).toBe(500)
  })

  it('does not reject the caller when onError throws on a synchronous setup failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const api = createApi({
      baseUrl: '',
      onError: explode,
      // A nested object in a query string makes buildUrl throw a TypeError
      // before the middleware chain ever starts — the second onError site.
      requests: { search: new Request<{ filter: unknown }, unknown>({ method: 'GET', path: '/search' }) },
    })

    const r = await api.search({ filter: { nested: true } })

    expect(r.error!.kind).toBe('network')
    expect(r.error!.body).toBeInstanceOf(TypeError)
  })
})

describe('onError is guarded — createGraphQL', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not reject the caller when onError throws on a GraphQL error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ errors: [{ message: 'nope' }] })),
    }))
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      onError: explode,
      operations: { broken: new Operation<Record<string, never>, unknown>({ operation: 'query { broken }' }) },
    })

    const { error } = await client.broken()

    expect(error).not.toBeNull()
    expect(error!.status).toBe(200)
  })

  it('does not reject the caller when onError throws on a synchronous setup failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      onError: explode,
      operations: { save: new Operation<Record<string, unknown>, unknown>({ operation: 'mutation { save }' }) },
    })

    // Circular variables make JSON.stringify throw before the chain starts —
    // the GraphQL client's own synchronous onError site.
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const { error } = await client.save(circular)

    expect(error!.kind).toBe('network')
    expect(error!.body).toBeInstanceOf(TypeError)
  })
})
