import { describe, it, expect, afterEach, vi } from 'vitest'
import { Operation, gql, createGraphQL } from '../src/graphql.js'
import type { Middleware } from '../src/types.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Operation', () => {
  it('stores the operation string', () => {
    const op = new Operation<{ id: string }, { name: string }>({
      operation: 'query GetUser($id: String!) { user(id: $id) { name } }',
    })
    expect(op.config.operation).toBe('query GetUser($id: String!) { user(id: $id) { name } }')
  })

  it('stores optional config fields', () => {
    const mw = vi.fn()
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: 'query { health }',
      dedupe: true,
      headers: { 'X-Custom': 'yes' },
      middleware: [mw],
    })
    expect(op.config.dedupe).toBe(true)
    expect(op.config.headers).toEqual({ 'X-Custom': 'yes' })
    expect(op.config.middleware).toEqual([mw])
  })
})

describe('gql', () => {
  it('returns the template string unchanged', () => {
    const query = gql`query GetUser($id: String!) { user(id: $id) { id name } }`
    expect(query).toBe('query GetUser($id: String!) { user(id: $id) { id name } }')
  })

  it('interpolates values', () => {
    const fields = 'id name'
    const query = gql`query { user { ${fields} } }`
    expect(query).toBe('query { user { id name } }')
  })

  it('preserves backslash escape sequences (String.raw behavior)', () => {
    const query = gql`query { user(filter: "\\w+") { id } }`
    expect(query).toBe('query { user(filter: "\\w+") { id } }')
  })
})

describe('createGraphQL — flat operations', () => {
  it('sends POST to the endpoint with { query, variables } body', async () => {
    const GET_USER = gql`query GetUser($id: String!) { user(id: $id) { id name } }`
    const getUser = new Operation<{ id: string }, { id: string; name: string }>({
      operation: GET_USER,
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '42', name: 'Alice' } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error } = await client.getUser({ id: '42' })

    expect(error).toBeNull()
    expect(data).toEqual({ id: '42', name: 'Alice' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/graphql',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: GET_USER, variables: { id: '42' } }),
      })
    )
  })

  it('sets Content-Type: application/json automatically', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    await client.health()

    const headers: Headers = mockFetch.mock.calls[0][1].headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })
})

describe('createGraphQL — split queries/mutations', () => {
  it('nests operations under client.query and client.mutation', async () => {
    const GET_USER = gql`query GetUser($id: String!) { user(id: $id) { id } }`
    const UPDATE_USER = gql`mutation UpdateUser($id: String!, $name: String!) { updateUser(id: $id, name: $name) { id } }`

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      queries: {
        getUser: new Operation<{ id: string }, { id: string }>({ operation: GET_USER }),
      },
      mutations: {
        updateUser: new Operation<{ id: string; name: string }, { id: string }>({ operation: UPDATE_USER }),
      },
    })

    const { data: queryData } = await client.query.getUser({ id: '1' })
    const { data: mutationData } = await client.mutation.updateUser({ id: '1', name: 'Bob' })

    expect(queryData).toEqual({ id: '1' })
    expect(mutationData).toEqual({ id: '1' })
  })

  it('exposes only client.query when only queries are provided', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      queries: { getUser: op },
    })

    expect(client).toHaveProperty('query.getUser')
    expect(client).not.toHaveProperty('mutation')
    const { data } = await client.query.getUser({ id: '1' })
    expect(data).toEqual({ id: '1' })
  })

  it('exposes only client.mutation when only mutations are provided', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`mutation DeleteUser($id: String!) { deleteUser(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      mutations: { deleteUser: op },
    })

    expect(client).toHaveProperty('mutation.deleteUser')
    expect(client).not.toHaveProperty('query')
    const { data } = await client.mutation.deleteUser({ id: '1' })
    expect(data).toEqual({ id: '1' })
  })
})

describe('createGraphQL — GraphQL errors (HTTP 200 with { errors })', () => {
  it('maps GraphQL errors to result.error, result.data is null', async () => {
    const getUser = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({
        data: null,
        errors: [{ message: 'User not found' }],
      })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error, response } = await client.getUser({ id: '99' })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.status).toBe(200)
    expect(error?.statusText).toBe('GraphQL Error')
    expect(error?.body).toEqual([{ message: 'User not found' }])
    expect(response).not.toBeNull()
    expect(response?.status).toBe(200)
  })
})

describe('createGraphQL — HTTP errors (4xx/5xx)', () => {
  it('maps a 404 response to result.error', async () => {
    const getUser = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ message: 'Not found' })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser },
    })

    const { data, error, response } = await client.getUser({ id: '99' })

    expect(data).toBeNull()
    expect(error?.status).toBe(404)
    expect(error?.body).toEqual({ message: 'Not found' })
    expect(response?.status).toBe(404)
  })

  it('maps a 500 response to result.error with null body when response is empty', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      text: () => Promise.resolve(''),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    const { data, error } = await client.health()

    expect(data).toBeNull()
    expect(error?.status).toBe(500)
    expect(error?.body).toBeNull()
  })
})

describe('createGraphQL — network errors', () => {
  it('maps a network failure to result.error with status 0, response is null', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
    })

    const { data, error, response } = await client.health()

    expect(data).toBeNull()
    expect(error?.status).toBe(0)
    expect(error?.body).toBeInstanceOf(TypeError)
    expect(response).toBeNull()
  })
})

describe('createGraphQL — onError callback', () => {
  it('fires onError for GraphQL errors', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'Oops' }] })),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
      onError,
    })

    await client.getUser({ id: '1' })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(200)
  })

  it('fires onError for HTTP errors', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(),
      text: () => Promise.resolve(''),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
      onError,
    })

    await client.getUser({ id: '1' })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(401)
  })

  it('fires onError for network errors', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      onError,
    })

    await client.health()

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].status).toBe(0)
  })

  it('does NOT fire onError on success', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const onError = vi.fn()
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      onError,
    })

    const { error } = await client.health()

    expect(error).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('createGraphQL — middleware', () => {
  it('runs global → per-operation → per-call middleware in order', async () => {
    const order: string[] = []
    const globalMw = vi.fn<Middleware>(async (_ctx, next) => { order.push('global'); return next() })
    const opMw = vi.fn<Middleware>(async (_ctx, next) => { order.push('operation'); return next() })
    const callMw = vi.fn<Middleware>(async (_ctx, next) => { order.push('call'); return next() })

    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
      middleware: [opMw],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [globalMw],
    })

    await client.health({}, { middleware: [callMw] })

    expect(order).toEqual(['global', 'operation', 'call'])
  })

  it('middleware can modify request headers', async () => {
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    })
    vi.stubGlobal('fetch', mockFetch)

    const authMw = vi.fn<Middleware>(async (ctx, next) => {
      ctx.request.headers.set('Authorization', 'Bearer token123')
      return next()
    })

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [authMw],
    })

    await client.health()

    const headers: Headers = mockFetch.mock.calls[0][1].headers
    expect(headers.get('Authorization')).toBe('Bearer token123')
  })

  it('skipMiddleware excludes middleware by reference', async () => {
    const mw = vi.fn<Middleware>(async (_ctx, next) => next())
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: gql`query { health }`,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ data: { ok: true } })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { health: op },
      middleware: [mw],
    })

    await client.health({}, { skipMiddleware: [mw] })

    expect(mw).not.toHaveBeenCalled()
  })
})

describe('createGraphQL — retry()', () => {
  it('retry() re-enters the full execution pipeline', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
    })
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers(),
          text: () => Promise.resolve(''),
        })
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: { id: '1' } })),
      })
    }))

    const mw = vi.fn<Middleware>(async (_ctx, next) => next())

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
      middleware: [mw],
    })

    const firstResult = await client.getUser({ id: '1' })
    expect(firstResult.error?.status).toBe(503)

    const retryResult = await firstResult.retry()
    expect(retryResult.data).toEqual({ id: '1' })
    expect(retryResult.error).toBeNull()
    expect(callCount).toBe(2)
    expect(mw).toHaveBeenCalledTimes(2)
  })
})

describe('createGraphQL — dedupe', () => {
  it('aborts the previous in-flight request when the same operation is called again', async () => {
    const op = new Operation<{ id: string }, { id: string }>({
      operation: gql`query GetUser($id: String!) { user(id: $id) { id } }`,
      dedupe: true,
    })

    let firstCallSignal: AbortSignal | undefined
    let callCount = 0

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++
      if (callCount === 1) {
        firstCallSignal = init.signal as AbortSignal
        return new Promise(() => {}) // hangs forever
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: { id: '2' } })),
      })
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { getUser: op },
    })

    // First call hangs — don't await
    client.getUser({ id: '1' })

    // Second call should abort the first
    await client.getUser({ id: '2' })

    expect(firstCallSignal?.aborted).toBe(true)
    expect(callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// timeout — the GraphQL path shares `timeoutSignalFor` with createApi, so it
// inherits every defect in it. Nothing here was covered by an executable test
// before: a defect living in the shared helper is exactly what a file-by-file
// comparison against the REST implementation cannot find.
// ---------------------------------------------------------------------------

/** A fetch that never resolves unless its signal aborts. */
function hangingGqlFetch() {
  return vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
    const s = init.signal as AbortSignal | undefined
    if (!s) { rej(new Error('no signal reached fetch')); return }
    if (s.aborted) { rej(s.reason); return }
    s.addEventListener('abort', () => rej(s.reason))
  }))
}

describe('createGraphQL — timeout', () => {
  it('aborts the operation and reports kind "timeout"', async () => {
    vi.stubGlobal('fetch', hangingGqlFetch())
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: {
        slow: new Operation<Record<string, never>, unknown>({ operation: 'query { slow }', timeout: 20 }),
      },
    })

    const { error } = await client.slow()

    expect(error).not.toBeNull()
    expect(error!.kind).toBe('timeout')
    expect(error!.status).toBe(0)
  })

  it('lets a per-call timeout override the per-operation one', async () => {
    vi.stubGlobal('fetch', hangingGqlFetch())
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: {
        slow: new Operation<Record<string, never>, unknown>({ operation: 'query { slow }', timeout: 10_000 }),
      },
    })

    const started = Date.now()
    const { error } = await client.slow({}, { timeout: 20 })

    expect(error!.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('accepts a fractional timeout instead of never sending the operation', async () => {
    // AbortSignal.timeout() throws a RangeError on a non-integer. Before the
    // fix that throw happened during setup, so the operation was never sent at
    // all and the caller got kind: 'network' with a RangeError body —
    // indistinguishable from being offline.
    const f = hangingGqlFetch()
    vi.stubGlobal('fetch', f)
    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: {
        slow: new Operation<Record<string, never>, unknown>({ operation: 'query { slow }', timeout: 20.5 }),
      },
    })

    const { error } = await client.slow()

    expect(f).toHaveBeenCalled()                      // the operation was actually issued
    expect(error!.body).not.toBeInstanceOf(RangeError)
    expect(error!.kind).toBe('timeout')
  })
})

describe('createGraphQL — error kind', () => {
  it('reports kind "http" for a GraphQL-errors response (HTTP 200)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ errors: [{ message: 'Field not found' }] })),
    }))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { broken: new Operation<Record<string, never>, unknown>({ operation: 'query { broken }' }) },
    })

    const { error } = await client.broken()

    // A GraphQL error is a server answer, not a transport failure: it must
    // classify as 'http' so consumers branching on kind do not mistake it for
    // a network problem worth retrying.
    expect(error!.kind).toBe('http')
    expect(error!.status).toBe(200)
  })
})

describe('createGraphQL — malformed body on a successful response', () => {
  it('reports kind "parse" with the real status and a non-null response', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('<html>oops</html>'),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse))

    const client = createGraphQL({
      endpoint: 'https://api.example.com/graphql',
      operations: { broken: new Operation<Record<string, never>, unknown>({ operation: 'query { broken }' }) },
    })

    const { data, error, response } = await client.broken()

    // Mirrors the REST parse-errors.test.ts assertions: the server answered
    // (2xx), but the body was not JSON. This must report as what it is --
    // kind 'parse' with the real status and Response -- not fall through to
    // the network catch (status 0, response null).
    expect(data).toBeNull()
    expect(error?.kind).toBe('parse')
    expect(error?.status).toBe(200)
    expect(response).not.toBeNull()
    expect(response?.status).toBe(200)
  })
})

describe('GraphQL partial data', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves partial data alongside the errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { user: { name: 'Ada' }, posts: null },
      errors: [{ message: 'posts unavailable' }],
    }), { status: 200 })))
    const client = createGraphQL({
      endpoint: '/gql',
      operations: { getUser: new Operation<Record<string, never>, { user: { name: string } }>({ operation: 'query { user { name } }' }) },
    })
    const r = await client.getUser()
    expect(r.error).not.toBeNull()
    expect(r.data).toBeNull()
    expect(r.error!.partialData).toEqual({ user: { name: 'Ada' }, posts: null })
  })

  it('leaves partialData undefined when no data came back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      errors: [{ message: 'totally broken' }],
    }), { status: 200 })))
    const client = createGraphQL({
      endpoint: '/gql',
      operations: { getUser: new Operation<Record<string, never>, unknown>({ operation: 'query { user { name } }' }) },
    })
    expect((await client.getUser()).error!.partialData).toBeUndefined()
  })
})
