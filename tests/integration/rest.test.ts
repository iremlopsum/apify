import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createApi } from '../../src/create-api.js'
import { Request } from '../../src/request.js'
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

describe('REST — core', () => {
  it('basic GET returns response data', async () => {
    const hello = new Request<Record<string, never>, { message: string }>({
      method: 'GET',
      path: '/hello',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { hello } })

    const { data, error } = await api.hello()

    expect(error).toBeNull()
    expect(data).toEqual({ message: 'hello' })
  })

  it('path params are substituted into the URL', async () => {
    const getUser = new Request<{ id: string }, { id: string; name: string }>({
      method: 'GET',
      path: '/users/:id',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { getUser } })

    const { data, error } = await api.getUser({ id: '42' })

    expect(error).toBeNull()
    expect(data).toEqual({ id: '42', name: 'User 42' })
  })

  it('GET params become query string, not request body', async () => {
    const search = new Request<{ q: string; page: string }, { params: Record<string, string> }>({
      method: 'GET',
      path: '/search',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { search } })

    const { data, error } = await api.search({ q: 'hello', page: '2' })

    expect(error).toBeNull()
    expect(data?.params).toEqual({ q: 'hello', page: '2' })
  })

  it('POST body is JSON-serialized with correct Content-Type', async () => {
    const echo = new Request<
      { name: string; age: number },
      { body: { name: string; age: number }; contentType: string }
    >({
      method: 'POST',
      path: '/echo',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { echo } })

    const { data, error } = await api.echo({ name: 'Alice', age: 30 })

    expect(error).toBeNull()
    expect(data?.body).toEqual({ name: 'Alice', age: 30 })
    expect(data?.contentType).toBe('application/json')
  })

  it('headers from all three layers reach the server', async () => {
    const getHeaders = new Request<Record<string, never>, { headers: Record<string, string> }>({
      method: 'GET',
      path: '/headers',
      headers: { 'X-Per-Request': 'req-value' },
    })
    const api = createApi({
      baseUrl: server.baseUrl,
      requests: { getHeaders },
      headers: { 'X-Global': 'global-value' },
    })

    const { data, error } = await api.getHeaders(
      {},
      { headers: { 'X-Per-Call': 'call-value' } },
    )

    // HTTP header names are lowercased in transit
    expect(error).toBeNull()
    expect(data?.headers['x-global']).toBe('global-value')
    expect(data?.headers['x-per-request']).toBe('req-value')
    expect(data?.headers['x-per-call']).toBe('call-value')
  })

  it('4xx response is returned as error Result — never thrown', async () => {
    const notFound = new Request<Record<string, never>, never>({
      method: 'GET',
      path: '/status/404',
    })
    const api = createApi({ baseUrl: server.baseUrl, requests: { notFound } })

    const { data, error } = await api.notFound()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.status).toBe(404)
  })
})
