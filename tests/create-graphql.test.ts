import { describe, it, expect, afterEach, vi } from 'vitest'
import { Operation, gql, createGraphQL } from '../src/graphql.js'

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
