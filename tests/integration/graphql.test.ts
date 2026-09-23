import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createGraphQL, Operation, gql } from '../../src/graphql.js'
import { startServer, type TestServer } from './server.js'

let server: TestServer

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.close()
})

afterEach(() => {
  server.callCounts.clear()
})

describe('GraphQL — flat client (operations)', () => {
  it('basic query returns data', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      operations: {
        hello: new Operation<Record<string, never>, { hello: string }>({
          operation: gql`query { gqlHello }`,
        }),
      },
    })

    const { data, error } = await client.hello()

    expect(error).toBeNull()
    expect(data).toEqual({ hello: 'world' })
  })

  it('query variables are serialized and sent to the server', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      operations: {
        getUser: new Operation<{ id: string }, { user: { id: string; name: string } }>({
          operation: gql`query gqlUser($id: ID!) { gqlUser(id: $id) { id name } }`,
        }),
      },
    })

    const { data, error } = await client.getUser({ id: '7' })

    expect(error).toBeNull()
    expect(data?.user).toEqual({ id: '7', name: 'User 7' })
    expect(server.callCounts.get('POST /graphql')).toBe(1)
  })

  it('GraphQL errors in response body (HTTP 200) are returned as error Result', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      operations: {
        failing: new Operation<Record<string, never>, never>({
          operation: gql`query { gqlError }`,
        }),
      },
    })

    const { data, error } = await client.failing()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    // GraphQL errors arrive as HTTP 200 but the library treats them as errors
    expect(error?.status).toBe(200)
    expect(Array.isArray(error?.body)).toBe(true)
    expect((error?.body as Array<{ message: string }>)[0].message).toBe('Something went wrong')
  })

  it('HTTP-level error (non-200) is returned as error Result with the HTTP status', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/status/500`,
      operations: {
        broken: new Operation<Record<string, never>, never>({
          operation: gql`query { anything }`,
        }),
      },
    })

    const { data, error } = await client.broken()

    expect(data).toBeNull()
    expect(error?.status).toBe(500)
  })

  it('reports a 200 carrying no data as a parse error', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      operations: {
        noData: new Operation<Record<string, never>, { thing: string }>({
          operation: gql`query { gqlNoData }`,
        }),
      },
    })

    const { data, error, response } = await client.noData()

    expect(error?.kind).toBe('parse')
    expect(error?.status).toBe(200)
    expect(error?.body).toBe('{}')
    expect(data).toBeNull()
    expect(response?.status).toBe(200)
  })
})

describe('GraphQL — split client (queries + mutations)', () => {
  it('query and mutation namespaces both work correctly', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      queries: {
        hello: new Operation<Record<string, never>, { hello: string }>({
          operation: gql`query { gqlHello }`,
        }),
      },
      mutations: {
        createUser: new Operation<{ name: string }, { createUser: { id: string; name: string } }>({
          operation: gql`mutation gqlMutation($name: String!) { gqlMutation(name: $name) { id name } }`,
        }),
      },
    })

    const { data: qData, error: qError } = await client.query.hello()
    expect(qError).toBeNull()
    expect(qData).toEqual({ hello: 'world' })

    const { data: mData, error: mError } = await client.mutation.createUser({ name: 'Bob' })
    expect(mError).toBeNull()
    expect(mData?.createUser).toEqual({ id: '99', name: 'Bob' })
    // Two real HTTP requests: one for the query, one for the mutation
    expect(server.callCounts.get('POST /graphql')).toBe(2)
  })
})

describe('GraphQL — a hung middleware against a real server', () => {
  it('settles with kind "timeout", and the resumed middleware sends nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let late: Promise<unknown> | undefined
    const kinds: string[] = []
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      // The second middleware installs a fresh, live signal once the first
      // resumes, so `fetch` itself would send — only the guard stops it.
      middleware: [
        async (_ctx, next) => { await gate; late = next(); return late as never },
        (ctx, next) => { ctx.request.signal = AbortSignal.timeout(5000); return next() },
      ],
      onError: e => { kinds.push(e.kind) },
      operations: {
        hello: new Operation<Record<string, never>, { hello: string }>({ operation: gql`query { gqlHello }`, timeout: 50 }),
      },
    })

    const started = Date.now()
    const r = await client.hello()
    expect(r.error?.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)

    release()
    await late
    await new Promise(res => setTimeout(res, 50))
    expect(server.callCounts.get('POST /graphql')).toBeUndefined()
    expect(kinds).toEqual(['timeout'])
  })

  it('settles with kind "abort" when the caller aborts', async () => {
    const client = createGraphQL({
      endpoint: `${server.baseUrl}/graphql`,
      middleware: [() => new Promise(() => {})],
      operations: {
        hello: new Operation<Record<string, never>, { hello: string }>({ operation: gql`query { gqlHello }` }),
      },
    })
    const ac = new AbortController()
    const p = client.hello({}, { signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    expect((await p).error?.kind).toBe('abort')
    expect(server.callCounts.get('POST /graphql')).toBeUndefined()
  })
})
